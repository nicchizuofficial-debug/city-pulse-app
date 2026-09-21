# -*- coding: utf-8 -*-
"""JR東日本(公共交通オープンデータチャレンジ限定ライセンス)のGTFSを、サーバー内だけで取得・保持し、
リクエストされた範囲内の運行だけを加工して返す。

限定ライセンス第8条4項により、GTFSそのもの(zip)や、そこから復元できる形の加工データを
第三者が再利用できる状態で公開・再配布してはならない。そのためこのモジュールは
  ・GTFS zipをファイルとして保存・配信しない(メモリ上にのみ保持)
  ・返すのは「指定範囲内の停車駅を結んだ運行アニメーション用データ」だけ
としている。アクセストークンは環境変数 ODPT_CHALLENGE_TOKEN(または pipeline/.odpt_token)から読む。
"""
import csv
import io
import os
import threading
import time
import zipfile
from array import array
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

PREF_NAMES = {
    1: "北海道", 2: "青森県", 3: "岩手県", 4: "宮城県", 5: "秋田県", 6: "山形県", 7: "福島県", 8: "茨城県", 9: "栃木県",
    10: "群馬県", 11: "埼玉県", 12: "千葉県", 13: "東京都", 14: "神奈川県", 15: "新潟県", 16: "富山県", 17: "石川県",
    18: "福井県", 19: "山梨県", 20: "長野県", 21: "岐阜県", 22: "静岡県", 23: "愛知県", 24: "三重県", 25: "滋賀県",
    26: "京都府", 27: "大阪府", 28: "兵庫県", 29: "奈良県", 30: "和歌山県", 31: "鳥取県", 32: "島根県", 33: "岡山県",
    34: "広島県", 35: "山口県", 36: "徳島県", 37: "香川県", 38: "愛媛県", 39: "高知県", 40: "福岡県", 41: "佐賀県",
    42: "長崎県", 43: "熊本県", 44: "大分県", 45: "宮崎県", 46: "鹿児島県", 47: "沖縄県",
}
GSI_REVERSE_URL = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress"
# 範囲内で最も運行本数の多い都道府県に対し、この割合以上の運行がある都道府県だけを表示対象にする
PREF_MIN_SHARE = 0.25

BASE_DIR = Path(__file__).resolve().parent
GTFS_URL = "https://api-challenge.odpt.org/api/v4/files/JR-East/data/JR-East-Train-GTFS.zip"
TOKEN_FILE = BASE_DIR / "pipeline" / ".odpt_token"
CACHE_TTL_SEC = 12 * 3600
MAX_TRIPS_RETURNED = 12000

_lock = threading.Lock()
_state = {"data": None, "loaded_at": 0.0, "error": None, "loading": False}


def _token() -> str:
    t = os.environ.get("ODPT_CHALLENGE_TOKEN", "").strip()
    if t:
        return t
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""


def has_token() -> bool:
    return bool(_token())


def _time_to_sec(s: str) -> int:
    if not s:
        return -1
    try:
        h, m, sec = s.split(":")
        return int(h) * 3600 + int(m) * 60 + int(sec)
    except ValueError:
        return -1


def _rows(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def _ymd(s: str):
    return datetime(int(s[:4]), int(s[4:6]), int(s[6:8]), tzinfo=timezone.utc)


def _parse(zip_bytes: bytes) -> dict:
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))

    stop_idx, stop_lon, stop_lat = {}, array("d"), array("d")
    for r in _rows(z, "stops.txt"):
        try:
            lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        except (ValueError, KeyError):
            continue
        stop_idx[r["stop_id"]] = len(stop_lat)
        stop_lat.append(lat)
        stop_lon.append(lon)

    route_name = {r["route_id"]: (r.get("route_long_name") or r.get("route_short_name") or r["route_id"])
                  for r in _rows(z, "routes.txt")}
    trips = {r["trip_id"]: (r["route_id"], r["service_id"]) for r in _rows(z, "trips.txt")}
    svc_trips = {}
    for _, svc in trips.values():
        svc_trips[svc] = svc_trips.get(svc, 0) + 1

    # 代表的な平日ダイヤ: 火〜木のうち運行便数が最大の日
    calendar = {}
    for r in _rows(z, "calendar.txt"):
        calendar[r["service_id"]] = (
            [r["sunday"] == "1", r["monday"] == "1", r["tuesday"] == "1", r["wednesday"] == "1",
             r["thursday"] == "1", r["friday"] == "1", r["saturday"] == "1"],
            _ymd(r["start_date"]), _ymd(r["end_date"]))
    exceptions = {}
    try:
        for r in _rows(z, "calendar_dates.txt"):
            exceptions.setdefault(_ymd(r["date"]), []).append((r["service_id"], r["exception_type"]))
    except KeyError:
        pass
    starts = [v[1] for v in calendar.values()] + list(exceptions)
    ends = [v[2] for v in calendar.values()] + list(exceptions)
    if not starts:
        raise ValueError("calendar情報がありません")

    def active_on(day):
        dow = (day.weekday() + 1) % 7   # 日曜=0
        act = {sid for sid, (flags, a, b) in calendar.items() if a <= day <= b and flags[dow]}
        for sid, typ in exceptions.get(day, []):
            if typ == "1":
                act.add(sid)
            elif typ == "2":
                act.discard(sid)
        return act

    best_day, best_cnt, best_set = None, 0, set()
    day, last = min(starts), min(max(ends), min(starts) + timedelta(days=1100))
    while day <= last:
        if day.weekday() in (1, 2, 3):
            act = active_on(day)
            cnt = sum(svc_trips.get(s, 0) for s in act)
            if cnt > best_cnt:
                best_day, best_cnt, best_set = day, cnt, act
        day += timedelta(days=1)
    if best_day is None:
        raise ValueError("運行日を特定できませんでした")

    active = {tid for tid, (_, svc) in trips.items() if svc in best_set}
    rows = {}
    for r in _rows(z, "stop_times.txt"):
        tid = r["trip_id"]
        if tid not in active:
            continue
        t = _time_to_sec(r["departure_time"])
        if t < 0:
            t = _time_to_sec(r["arrival_time"])
        rows.setdefault(tid, []).append((int(r["stop_sequence"] or 0), stop_idx.get(r["stop_id"], -1), t))

    out = []
    for tid, lst in rows.items():
        lst.sort()
        known = [i for i, (_, _, t) in enumerate(lst) if t >= 0]
        if len(known) < 2:
            continue
        first, last_i = known[0], known[-1]
        stops, times = array("i"), array("i")
        prev = first
        for i in range(first, last_i + 1):
            seq, si, t = lst[i]
            if t >= 0:
                # 直前の時刻ありの停車駅から今回までの間を直線補間する
                pi = prev
                if i - pi > 1:
                    t0 = lst[pi][2]
                    for k in range(pi + 1, i):
                        sk = lst[k][1]
                        if sk >= 0:
                            stops.append(sk)
                            times.append(int(t0 + (t - t0) * (k - pi) / (i - pi)))
                prev = i
            if t >= 0 and si >= 0:
                stops.append(si)
                times.append(t)
        if len(stops) >= 2:
            out.append((route_name.get(trips[tid][0], "?"), stops, times))

    return {
        "stop_lon": stop_lon, "stop_lat": stop_lat, "trips": out,
        "pref": _resolve_prefectures(stop_lon, stop_lat),
        "service_date": best_day.strftime("%Y-%m-%d"),
    }


def _lookup_pref(lon: float, lat: float) -> int:
    """国土地理院の逆ジオコーダで、座標の都道府県コード(市区町村コードの先頭2桁)を返す。失敗時は0。"""
    for _ in range(2):
        try:
            r = requests.get(GSI_REVERSE_URL, params={"lat": lat, "lon": lon}, timeout=10)
            if r.ok:
                muni = (r.json().get("results") or {}).get("muniCd") or ""
                if len(muni) >= 2 and muni[:2].isdigit():
                    return int(muni[:2])
                return 0
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    return 0


def _resolve_prefectures(stop_lon, stop_lat) -> array:
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=12) as ex:
        codes = list(ex.map(_lookup_pref, stop_lon, stop_lat))
    if sum(1 for c in codes if c) < len(codes) * 0.5:
        codes = [0] * len(codes)   # 判定できなかった(APIが使えない等)場合は、都道府県での絞り込みをしない
    return array("b", codes)


def _download() -> bytes:
    token = _token()
    if not token:
        raise RuntimeError("ODPT_CHALLENGE_TOKEN が設定されていません")
    r = requests.get(GTFS_URL, params={"acl:consumerKey": token}, timeout=120, allow_redirects=True)
    r.raise_for_status()
    return r.content


def ensure_loaded():
    """メモリ上のデータを返す。期限切れなら再取得(失敗時は古いデータを使い続ける)。"""
    now = time.time()
    if _state["data"] is not None and now - _state["loaded_at"] < CACHE_TTL_SEC:
        return _state["data"]
    with _lock:
        now = time.time()
        if _state["data"] is not None and now - _state["loaded_at"] < CACHE_TTL_SEC:
            return _state["data"]
        _state["loading"] = True
        try:
            _state["data"] = _parse(_download())
            _state["loaded_at"] = time.time()
            _state["error"] = None
        except Exception as e:  # noqa: BLE001
            _state["error"] = str(e)
            if _state["data"] is None:
                raise
        finally:
            _state["loading"] = False
        return _state["data"]


def warm_up():
    """起動直後にバックグラウンドで読み込んでおく(初回リクエストの待ちを減らす)。"""
    if not has_token():
        return

    def run():
        try:
            ensure_loaded()
        except Exception as e:  # noqa: BLE001
            _state["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()


def status() -> dict:
    return {"has_token": has_token(), "loaded": _state["data"] is not None, "loading": _state["loading"], "error": _state["error"]}


def trips_in_window(west: float, south: float, east: float, north: float, filter_prefectures: bool = True) -> dict:
    """指定範囲内のJR東日本の運行を返す。既定では、範囲内で運行本数の多い都道府県だけに絞る。"""
    d = ensure_loaded()
    lon, lat, pref = d["stop_lon"], d["stop_lat"], d["pref"]
    inside = [west <= lon[i] <= east and south <= lat[i] <= north for i in range(len(lat))]

    cands = []   # (路線名, [(停留所index, 時刻), ...])
    pref_trips = {}
    for name, stops, times in d["trips"]:
        pts, last_t, seen = [], -1, set()
        for si, t in zip(stops, times):
            if not inside[si]:
                continue
            t = max(t, last_t)
            last_t = t
            pts.append((si, t))
            if pref[si]:
                seen.add(pref[si])
        if len(pts) >= 2:
            cands.append((name, pts))
            for p in seen:
                pref_trips[p] = pref_trips.get(p, 0) + 1

    # 運行本数が最も多い都道府県に対して一定割合以上ある都道府県だけを残す(判定できない停留所は残す)
    top = max(pref_trips.values()) if pref_trips else 0
    kept = {p for p, c in pref_trips.items() if c >= top * PREF_MIN_SHARE}
    if not filter_prefectures:
        kept = set(pref_trips)
    trips = []
    for name, pts in cands:
        path, ts = [], []
        for si, t in pts:
            if pref[si] and pref[si] not in kept:
                continue
            path.append([round(lon[si], 5), round(lat[si], 5)])
            ts.append(t)
        if len(path) >= 2:
            trips.append({"mode": "rail", "route_name": name, "path": path, "timestamps": ts})
            if len(trips) >= MAX_TRIPS_RETURNED:
                break
    prefectures = [{"code": p, "name": PREF_NAMES.get(p, str(p)), "trips": c, "kept": p in kept}
                   for p, c in sorted(pref_trips.items(), key=lambda kv: -kv[1])]
    return {"available": True, "service_date": d["service_date"], "trips": trips, "prefectures": prefectures}
