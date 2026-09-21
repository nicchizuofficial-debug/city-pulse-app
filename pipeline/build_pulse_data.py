# -*- coding: utf-8 -*-
"""都市の鼓動(City Pulse)ビジュアライザー用データセットを構築する。

data/anim_cache/{bus,rail}_stop_times.parquet(対象エリア内の全時刻を含む
GTFS停車記録キャッシュ。モグルートプロジェクトの pipeline/build_transit_animation.py
--build-cache で作られたものと同じ形式・同じ千代田区データを再利用している)から、
24時間分すべての便を切り出し、deck.gl TripsLayer 用の {path, timestamps} 形式と、
「鼓動」を表現する5分刻みの稼働便数ヒストグラム(EKG風パルスチャート用)を書き出す。

バスは1日で4万便近くあり、そのまま全件書き出すとペイロードが大きくなりすぎるため、
視覚的な密度を保ちつつ間引く(既定30%サンプリング)。鉄道は元々便数が少ないため
間引かない。

実行方法:
    python pipeline/build_pulse_data.py
"""
import json
import random
import sys
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "data" / "anim_cache"
OUT_PATH = BASE_DIR / "data" / "transit_pulse.json"

DAY_SEC = 86400
BUCKET_SEC = 5 * 60          # ヒストグラムの粒度(5分)
BUS_SAMPLE_RATE = 0.3        # バスは3割だけ書き出す(視覚密度は保ちつつ軽量化)
RANDOM_SEED = 42


def load_full_day(mode: str) -> pd.DataFrame:
    path = CACHE_DIR / f"{mode}_stop_times.parquet"
    df = pd.read_parquet(path)
    return df


def trips_from_df(df: pd.DataFrame, mode: str, route_names: dict, sample_rate: float = 1.0) -> list:
    rng = random.Random(RANDOM_SEED)
    trip_ids = df["trip_id"].unique()
    if sample_rate < 1.0:
        keep = set(t for t in trip_ids if rng.random() < sample_rate)
        df = df[df["trip_id"].isin(keep)]

    out = []
    for trip_id, g in df.sort_values(["trip_id", "stop_sequence"]).groupby("trip_id", sort=False):
        if len(g) < 2:
            continue
        path = g[["lon", "lat"]].round(6).values.tolist()
        timestamps = g["t"].astype(int).tolist()
        route_id = g["route_id"].iloc[0]
        out.append({
            "mode": mode,
            "route_name": route_names.get(route_id, route_id or "?"),
            "path": path,
            "timestamps": timestamps,
        })
    return out


def build_activity_histogram(all_trips: list) -> list:
    """5分刻みで「その時刻に走行中の便数」を鉄道・バス別に数え、鼓動(EKG風)チャート用データを作る。"""
    n_buckets = DAY_SEC // BUCKET_SEC
    rail_counts = [0] * n_buckets
    bus_counts = [0] * n_buckets
    for trip in all_trips:
        ts = trip["timestamps"]
        if len(ts) < 2:
            continue
        counts = rail_counts if trip["mode"] == "rail" else bus_counts
        start_bucket = max(0, ts[0] // BUCKET_SEC)
        end_bucket = min(n_buckets - 1, ts[-1] // BUCKET_SEC)
        for b in range(start_bucket, end_bucket + 1):
            counts[b] += 1
    return [
        {"t": b * BUCKET_SEC, "rail": rail_counts[b], "bus": bus_counts[b], "count": rail_counts[b] + bus_counts[b]}
        for b in range(n_buckets)
    ]


def main():
    print("[build_pulse_data] キャッシュ読み込み中...")
    bus_df = load_full_day("bus")
    rail_df = load_full_day("rail")

    with open(CACHE_DIR / "bus_meta.json", encoding="utf-8") as f:
        bus_routes = json.load(f)["route_names"]
    with open(CACHE_DIR / "rail_meta.json", encoding="utf-8") as f:
        rail_routes = json.load(f)["route_names"]

    print(f"[build_pulse_data] バス便を{BUS_SAMPLE_RATE*100:.0f}%サンプリングして書き出し中...")
    bus_trips = trips_from_df(bus_df, "bus", bus_routes, sample_rate=BUS_SAMPLE_RATE)
    print(f"[build_pulse_data] 都営地下鉄便を書き出し中...")
    rail_trips = trips_from_df(rail_df, "rail", rail_routes, sample_rate=1.0)

    # JR東日本(公共交通オープンデータチャレンジ限定ライセンス)は、加工データも含めて公開できないため、
    # 既定では取り込まない(東京サンプルのJRは、表示時にサーバーがトークンで取得して重ねる)。
    # 手元だけで試す場合に限り --with-jr で取り込める。出力(transit_pulse.json)を公開してはいけない。
    # route_idが都営側と衝突しないよう "jr_" 接頭辞で名前空間を分ける。
    jreast_path = CACHE_DIR / "jreast_stop_times.parquet"
    jreast_meta_path = CACHE_DIR / "jreast_meta.json"
    if "--with-jr" in sys.argv and jreast_path.exists() and jreast_meta_path.exists():
        print(f"[build_pulse_data] JR東日本便を書き出し中...")
        jreast_df = pd.read_parquet(jreast_path)
        jreast_df = jreast_df.assign(route_id="jr_" + jreast_df["route_id"].astype(str))
        with open(jreast_meta_path, encoding="utf-8") as f:
            jreast_routes = json.load(f)["route_names"]
        jreast_routes = {f"jr_{k}": v for k, v in jreast_routes.items()}
        jreast_trips = trips_from_df(jreast_df, "rail", jreast_routes, sample_rate=1.0)
    else:
        jreast_trips = []

    all_trips = bus_trips + rail_trips + jreast_trips
    print(
        f"[build_pulse_data] 合計便数: {len(all_trips)} "
        f"(バス{len(bus_trips)} / 都営{len(rail_trips)} / JR東日本{len(jreast_trips)})"
    )

    activity = build_activity_histogram(all_trips)
    max_count = max((b["count"] for b in activity), default=1)

    result = {
        "duration_sec": DAY_SEC,
        "bucket_sec": BUCKET_SEC,
        "max_activity": max_count,
        "activity": activity,
        "trips": all_trips,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)

    size_mb = OUT_PATH.stat().st_size / (1024 * 1024)
    print(f"[build_pulse_data] 保存: {OUT_PATH} ({size_mb:.1f}MB)")


if __name__ == "__main__":
    main()
