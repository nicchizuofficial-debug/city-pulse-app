# -*- coding: utf-8 -*-
"""対象エリアの建物3D形状をOverpass API(OSM)から取得し、
data/buildings_3d.json (`[{"polygon": [[lon,lat],...], "height": m}, ...]`) として書き出す。

東京23区全体を対象にすると建物総数が100万棟を超えブラウザで描画できないため、
中高層以上(building:levels>=5 または height>=10m相当)の建物だけに絞り込んで
約9万棟に抑えている。

実行方法:
    python pipeline/fetch_buildings.py
"""
import json
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent.parent
OUT_PATH = BASE_DIR / "data" / "buildings_3d.json"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# (south, west, north, east) — 東京23区全体を覆うバウンディングボックス
BBOX = (35.52, 139.56, 35.82, 139.92)
# building:levels>=5 or height>=10m相当の建物のみに絞る(23区全域で約9万棟)
LEVELS_PATTERN = r"^([5-9]|[1-9][0-9]+)$"
HEIGHT_PATTERN = r"^([1-9][0-9]|[1-9][0-9]{2,})(\.[0-9]+)?\s?m?$"

DEFAULT_HEIGHT = 15.0
LEVEL_HEIGHT_M = 3.5


def fetch_ways() -> list:
    query = f"""
    [out:json][timeout:400];
    (
      way["building"]["building:levels"~"{LEVELS_PATTERN}"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
      way["building"]["height"~"{HEIGHT_PATTERN}"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
    );
    out body geom;
    """
    print("[fetch_buildings] Overpass APIへ問い合わせ中(23区全域のため数分~十数分かかります)...")
    r = requests.post(
        OVERPASS_URL,
        data={"data": query},
        headers={"User-Agent": "CityPulse-buildings-fetch/1.0"},
        timeout=600,
    )
    r.raise_for_status()
    return r.json()["elements"]


def height_of(tags: dict) -> float:
    h = tags.get("height")
    if h:
        try:
            v = float(str(h).replace("m", "").strip())
            if v >= 3:
                return v
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            v = float(levels) * LEVEL_HEIGHT_M
            if v >= 3:
                return v
        except ValueError:
            pass
    return DEFAULT_HEIGHT


def main():
    elements = fetch_ways()
    print(f"[fetch_buildings] 取得した建物(way): {len(elements)}")

    out = []
    seen_ids = set()
    for el in elements:
        if el["id"] in seen_ids:
            continue
        seen_ids.add(el["id"])
        geom = el.get("geometry")
        if not geom or len(geom) < 3:
            continue
        polygon = [[round(pt["lon"], 6), round(pt["lat"], 6)] for pt in geom]
        if polygon[0] != polygon[-1]:
            polygon.append(polygon[0])
        height = height_of(el.get("tags") or {})
        out.append({"polygon": polygon, "height": height})

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    size_mb = OUT_PATH.stat().st_size / (1024 * 1024)
    print(f"[fetch_buildings] 保存: {OUT_PATH} ({len(out)}棟 / {size_mb:.1f}MB)")


if __name__ == "__main__":
    main()
