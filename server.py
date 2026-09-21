# -*- coding: utf-8 -*-
"""都市の鼓動(City Pulse) — バックエンド。

タスクのない純粋な鑑賞用3Dビジュアライザーのため、ルーティング計算等は行わず、
    - 静的データ(建物・24時間分のGTFS運行アニメーション)の配信
    - 現在の実況天気(降水・暑さ指数)の取得プロキシ(CORS回避・キー不要の公開APIを利用)
の2つだけを提供する薄いFastAPIサーバー。

起動方法:
    python pipeline/build_pulse_data.py   # 初回のみ (24時間分データ生成)
    python server.py                       # または: uvicorn server:app --port 8600
"""
import io
import math
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

import jreast

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
WEB_DIR = BASE_DIR / "web"

JST = timezone(timedelta(hours=9))
JMA_NOWCAST_TARGET_TIMES = "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json"
WBGT_POINT_NO = 44132  # 東京(文京区小石川植物園) - 対象エリア(千代田区)に最も近い公式観測地点
CENTER_LAT, CENTER_LON = 35.6866, 139.7622  # 対象エリア(千代田区)中心付近

app = FastAPI(title="City Pulse API", description="都市の鼓動 - 24時間ビジュアライザー用バックエンド")
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def revalidate_app_files(request, call_next):
    # 画面・スクリプトは毎回更新の有無を確認させる(デプロイ後に古い画面が残らないように)。変更が無ければ304で軽い。
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

class DataFiles(StaticFiles):
    """東京サンプルの表示に必要なファイルだけを配信する。
    data/anim_cache/ にはチャレンジ限定ライセンスのJR東日本由来データが含まれるため、公開しない。
    (_test/ は手元の動作確認用で、リポジトリには含まれない)"""
    ALLOWED = {"buildings_3d.json", "transit_pulse.json"}

    async def get_response(self, path, scope):
        norm = path.replace("\\", "/")
        if norm not in self.ALLOWED and not norm.startswith("_test/"):
            raise HTTPException(status_code=404)
        return await super().get_response(path, scope)


if DATA_DIR.exists():
    app.mount("/data", DataFiles(directory=str(DATA_DIR)), name="data")
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.on_event("startup")
def _warm_up_jreast():
    jreast.warm_up()


@app.get("/api/jr-east")
def jr_east(w: float, s: float, e: float, n: float, prefs: str = "auto"):
    """指定範囲内のJR東日本の運行(加工済み)を返す。GTFSそのものは返さない。"""
    if not jreast.has_token():
        return {"available": False, "reason": "JR東日本データは、このサーバーでは未設定です"}
    if (e - w) > 1.0 or (n - s) > 1.0:
        return {"available": False, "reason": "範囲が広すぎます"}
    try:
        return jreast.trips_in_window(w, s, e, n, filter_prefectures=(prefs != "all"))
    except Exception as ex:  # noqa: BLE001
        return {"available": False, "reason": f"JR東日本データを取得できませんでした: {ex}"}


@app.get("/api/jr-east/status")
def jr_east_status():
    return jreast.status()


@app.get("/")
def index():
    return FileResponse(str(WEB_DIR / "index.html"))


_weather_cache = {"key": None, "data": None}


def _lonlat_to_tile(lon: float, lat: float, z: int) -> tuple:
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y


def _classify_precip_pixel(rgb: tuple) -> float:
    """RGBピクセルから近似降水強度(mm/h)を推定する(参考値)。

    気象庁は降水ナウキャストタイルの正式なRGB配色表を公開していないため、
    一般に知られる降水強度配色(弱=青→強=赤紫)に基づく色相分類を用いる。
    """
    r, g, b = rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0
    mx, mn = max(r, g, b), min(r, g, b)
    v = mx
    if v < 0.15:
        return 0.0
    sat = 0.0 if mx == 0 else (mx - mn) / mx
    if sat < 0.25:
        return 0.0
    if mx == mn:
        hue = 0.0
    elif mx == r:
        hue = (60 * ((g - b) / (mx - mn)) + 360) % 360
    elif mx == g:
        hue = 60 * ((b - r) / (mx - mn)) + 120
    else:
        hue = 60 * ((r - g) / (mx - mn)) + 240
    if 260 <= hue <= 330:
        return 90.0
    if hue < 20 or hue > 340:
        return 40.0
    if 20 <= hue < 55:
        return 15.0
    if 55 <= hue <= 260:
        return 3.0
    return 0.0


def _fetch_precipitation_intensity() -> float:
    """気象庁 高解像度降水ナウキャストのタイル画像から対象エリアの最大降水強度を推定する。"""
    try:
        req = urllib.request.Request(JMA_NOWCAST_TARGET_TIMES, headers={"User-Agent": "CityPulse/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            import json as _json
            times = _json.load(r)
        latest = times[0]
        basetime, validtime = latest["basetime"], latest["validtime"]
        z = 10
        x, y = _lonlat_to_tile(CENTER_LON, CENTER_LAT, z)
        url = (
            f"https://www.jma.go.jp/bosai/jmatile/data/nowc/{basetime}/none/"
            f"{validtime}/surf/hrpns/{z}/{x}/{y}.png"
        )
        req2 = urllib.request.Request(url, headers={"User-Agent": "CityPulse/1.0"})
        with urllib.request.urlopen(req2, timeout=8) as r2:
            raw = r2.read()
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
        max_intensity = 0.0
        for count, rgba in (img.getcolors(maxcolors=1_000_000) or []):
            if rgba[3] == 0:
                continue
            max_intensity = max(max_intensity, _classify_precip_pixel(rgba[:3]))
        return max_intensity
    except Exception:
        return 0.0


def _risk_level(kind: str, value: float) -> str:
    if kind == "precip":
        if value >= 30:
            return "extreme"
        if value >= 10:
            return "high"
        if value >= 1:
            return "moderate"
        return "low"
    # wbgt
    if value >= 31:
        return "extreme"
    if value >= 28:
        return "high"
    if value >= 25:
        return "moderate"
    return "low"


@app.get("/api/weather")
def weather():
    """現在の降水・暑さ指数の実況値を返す(1分キャッシュ)。取得失敗時は低リスク値で応答する。"""
    now = datetime.now(JST)
    cache_key = now.strftime("%Y%m%d%H%M")
    if _weather_cache["key"] == cache_key:
        return _weather_cache["data"]

    precip_intensity = _fetch_precipitation_intensity()

    wbgt_intensity = 0.0
    try:
        date_from = (now - timedelta(hours=3)).strftime("%Y%m%d%H%M%S")
        date_to = now.strftime("%Y%m%d%H%M%S")
        url = (
            "https://www.wbgt.env.go.jp/api/v1/getSurveyData"
            f"?data_type=0&data_type=1&location_type=1&wbgt_nos={WBGT_POINT_NO}"
            f"&date_from={date_from}&date_to={date_to}"
        )
        r = requests.get(url, headers={"User-Agent": "CityPulse/1.0"}, timeout=8)
        payload = r.json()
        if payload.get("status") == "success" and payload.get("data"):
            wbgt_intensity = float(payload["data"][-1]["wbgt_WO"])
    except Exception:
        pass

    result = {
        "precipitation": {"intensity": round(precip_intensity, 1), "risk_level": _risk_level("precip", precip_intensity)},
        "wbgt": {"intensity": round(wbgt_intensity, 1), "risk_level": _risk_level("wbgt", wbgt_intensity)},
        "observed_at": now.isoformat(),
    }
    _weather_cache["key"] = cache_key
    _weather_cache["data"] = result
    return result


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8600, reload=True)
