# -*- coding: utf-8 -*-
"""公共交通オープンデータチャレンジ2026 経由でJR東日本のGTFSを取得し、
千代田区周辺を通る平日ダイヤの便だけを anim_cache 形式(rail_stop_times.parquet と
同じスキーマ)で書き出す。JR線は関東一円をカバーする長距離便が多いため、
エリア外の区間は切り落として描画量を抑える。

事前準備:
    アクセストークンを環境変数 ODPT_CHALLENGE_TOKEN に設定するか、
    pipeline/.odpt_token ファイルに1行で保存しておく。

実行方法:
    python pipeline/fetch_jreast.py
"""
import io
import os
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "data" / "anim_cache"
TOKEN_FILE = Path(__file__).resolve().parent / ".odpt_token"
GTFS_URL = "https://api-challenge.odpt.org/api/v4/files/JR-East/data/JR-East-Train-GTFS.zip"

# 千代田区周辺を通るかどうかの判定に使う範囲(既存の都営データとほぼ同じ広さ)
BBOX_LAT = (35.60, 35.80)
BBOX_LON = (139.65, 139.88)


def get_token() -> str:
    token = os.environ.get("ODPT_CHALLENGE_TOKEN")
    if token:
        return token
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    raise SystemExit(
        "ODPT_CHALLENGE_TOKEN が未設定です。環境変数か pipeline/.odpt_token に保存してください。"
    )


def download_gtfs() -> zipfile.ZipFile:
    token = get_token()
    print("[fetch_jreast] JR東日本GTFSをダウンロード中...")
    r = requests.get(GTFS_URL, params={"acl:consumerKey": token}, timeout=120)
    r.raise_for_status()
    return zipfile.ZipFile(io.BytesIO(r.content))


def time_to_sec(series: pd.Series) -> pd.Series:
    parts = series.str.split(":", expand=True)
    h = pd.to_numeric(parts[0], errors="coerce")
    m = pd.to_numeric(parts[1], errors="coerce")
    s = pd.to_numeric(parts[2], errors="coerce")
    return h * 3600 + m * 60 + s


def interpolate_group(g: pd.DataFrame) -> pd.DataFrame:
    known = g["t_known"].values
    idx = np.arange(len(known))
    mask = ~np.isnan(known)
    if mask.sum() < 2:
        g["t"] = known
        return g
    g["t"] = np.interp(idx, idx[mask], known[mask])
    return g


def main():
    zf = download_gtfs()

    with zf.open("stops.txt") as f:
        stops = pd.read_csv(f, dtype={"stop_id": str})
    with zf.open("routes.txt") as f:
        routes = pd.read_csv(f, dtype={"route_id": str})
    with zf.open("trips.txt") as f:
        trips = pd.read_csv(f, dtype={"trip_id": str, "route_id": str, "service_id": str})
    with zf.open("calendar.txt") as f:
        calendar = pd.read_csv(f, dtype={"service_id": str})
    with zf.open("stop_times.txt") as f:
        stop_times = pd.read_csv(
            f,
            dtype={"trip_id": str, "stop_id": str, "arrival_time": str, "departure_time": str},
        )

    weekday_services = set(
        calendar[(calendar.monday == 1) & (calendar.saturday == 0) & (calendar.sunday == 0)]["service_id"]
    )
    weekday_trip_ids = set(trips[trips.service_id.isin(weekday_services)]["trip_id"])
    print(f"[fetch_jreast] 平日ダイヤの便(全国): {len(weekday_trip_ids)}")

    stop_times = stop_times[stop_times.trip_id.isin(weekday_trip_ids)]
    stop_times = stop_times.merge(
        stops[["stop_id", "stop_lat", "stop_lon", "stop_name"]], on="stop_id", how="left"
    )
    stop_times = stop_times.dropna(subset=["stop_lat", "stop_lon"])

    in_bbox = stop_times.stop_lat.between(*BBOX_LAT) & stop_times.stop_lon.between(*BBOX_LON)
    relevant_trip_ids = set(stop_times.loc[in_bbox, "trip_id"].unique())
    print(f"[fetch_jreast] 対象エリアを通る便: {len(relevant_trip_ids)}")

    stop_times = stop_times[stop_times.trip_id.isin(relevant_trip_ids)].sort_values(
        ["trip_id", "stop_sequence"]
    )

    dep = time_to_sec(stop_times["departure_time"])
    arr = time_to_sec(stop_times["arrival_time"])
    stop_times["t_known"] = dep.combine_first(arr)

    stop_times = stop_times.groupby("trip_id", group_keys=False, sort=False).apply(interpolate_group)
    stop_times = stop_times.dropna(subset=["t"])

    in_bbox = stop_times.stop_lat.between(*BBOX_LAT) & stop_times.stop_lon.between(*BBOX_LON)
    stop_times = stop_times[in_bbox]

    counts = stop_times.groupby("trip_id").size()
    keep_ids = counts[counts >= 2].index
    stop_times = stop_times[stop_times.trip_id.isin(keep_ids)]
    print(f"[fetch_jreast] 範囲内2駅以上の便: {stop_times.trip_id.nunique()}")

    trip_route = trips.set_index("trip_id")["route_id"].to_dict()
    stop_times["route_id"] = stop_times["trip_id"].map(trip_route)

    out = stop_times.rename(columns={"stop_lon": "lon", "stop_lat": "lat"})[
        ["trip_id", "route_id", "stop_sequence", "t", "lon", "lat", "stop_name"]
    ].copy()
    out["t"] = out["t"].astype(int)
    out["lon"] = out["lon"].round(6)
    out["lat"] = out["lat"].round(6)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out.to_parquet(CACHE_DIR / "jreast_stop_times.parquet", index=False)

    route_names = dict(zip(routes.route_id, routes.route_long_name))
    used_route_ids = set(out.route_id.unique())
    route_names = {k: v for k, v in route_names.items() if k in used_route_ids}
    import json

    with open(CACHE_DIR / "jreast_meta.json", "w", encoding="utf-8") as f:
        json.dump({"agency_id": "odpt.Operator:JR-East", "route_names": route_names}, f, ensure_ascii=False)

    print(f"[fetch_jreast] 保存: {CACHE_DIR / 'jreast_stop_times.parquet'} ({len(out)}行 / {out.trip_id.nunique()}便)")
    print(f"[fetch_jreast] 路線: {sorted(set(route_names.values()))}")


if __name__ == "__main__":
    main()
