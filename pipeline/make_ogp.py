"""OGP画像(1200x630)とホーム画面用アイコンを、東京サンプルの運行データから描く。

data/transit_pulse.json(都営地下鉄・都営バス・都電・日暮里舎人ライナー。JRは含まない)の
全便の経路を光の線として重ね、1日の鼓動チャートとタイトルを添える。

    python pipeline/make_ogp.py

出力: web/ogp.png, web/apple-touch-icon.png
必要: Pillow, numpy / フォント: 游明朝 Demibold・Consolas・游ゴシック(Windows標準)
"""
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = Path("C:/Windows/Fonts")
W, H = 1200, 630
SS = 2  # 線を滑らかにするための超解像倍率
BG = (3, 4, 10)
RAIL = np.array([94, 234, 212], dtype=np.float32)
BUS = np.array([251, 146, 60], dtype=np.float32)


def font(name, size, index=0):
    return ImageFont.truetype(str(FONTS / name), size, index=index)


def network_layer(trips, mode, project, w, h):
    """同じ区間を通る便が多いほど明るい線(0〜1のfloat配列)を返す"""
    seg = Counter()
    for t in trips:
        if t["mode"] != mode:
            continue
        pts = [project(p) for p in t["path"]]
        for a, b in zip(pts, pts[1:]):
            if a != b:
                seg[(a, b) if a < b else (b, a)] += 1
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    top = math.log1p(max(seg.values()))
    width = 3 if mode == "rail" else 2
    for (a, b), n in sorted(seg.items(), key=lambda kv: kv[1]):
        v = 0.25 + 0.75 * math.log1p(n) / top
        draw.line([a, b], fill=int(255 * v), width=width * SS)
    img = img.resize((W, H), Image.LANCZOS)
    core = np.asarray(img, dtype=np.float32) / 255
    glow = np.asarray(img.filter(ImageFilter.GaussianBlur(9)), dtype=np.float32) / 255
    wide = np.asarray(img.filter(ImageFilter.GaussianBlur(28)), dtype=np.float32) / 255
    return core, glow, wide


def main():
    d = json.loads((ROOT / "data" / "transit_pulse.json").read_text(encoding="utf-8"))
    trips = d["trips"]

    # 表示範囲: 皇居付近を中心に、右寄りに都市を置く(左にタイトル)
    cx, cy = 139.735, 35.690
    span_x = 0.19
    kx = math.cos(math.radians(cy))
    scale = (W * SS) / span_x
    ox = W * SS * 0.72

    def project(p):
        x = ox + (p[0] - cx) * scale * kx
        y = H * SS * 0.46 - (p[1] - cy) * scale
        return (round(x), round(y))

    rail = network_layer(trips, "rail", project, W * SS, H * SS)
    bus = network_layer(trips, "bus", project, W * SS, H * SS)

    img = np.zeros((H, W, 3), dtype=np.float32)
    img[:] = BG
    # 背景のうっすらとした光
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    amb = np.exp(-(((xx - W * 0.62) / 520) ** 2 + ((yy - H * 0.45) / 330) ** 2))
    img += amb[..., None] * np.array([10, 26, 30], dtype=np.float32)
    # 都心部を拡大して、データ範囲(矩形)の縁は画面の外へ。周辺は外へ向かって溶かす
    fall = np.exp(-(((xx - W * 0.80) / 560) ** 2 + ((yy - H * 0.40) / 380) ** 2) ** 1.4)
    fall *= np.clip((xx - 690) / 190, 0, 1) ** 1.3 * np.clip(yy / 90, 0, 1)
    for (core, glow, wide), col, k in ((bus, BUS, 0.62), (rail, RAIL, 1.0)):
        light = (core * 0.85 * k + glow * 0.9 * k + wide * 0.45 * k) * fall
        img = 255 - (255 - img) * (1 - np.clip(light, 0, 1)[..., None] * (col / 255))  # スクリーン合成

    # タイトル側(左)を暗く落とす
    fade = np.clip((xx - W * 0.10) / (W * 0.42), 0, 1) ** 1.4
    img = img * (0.18 + 0.82 * fade[..., None])
    img[..., :] = np.maximum(img, np.array(BG, dtype=np.float32))
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")

    # 下部: 実データの鼓動チャート(鉄道=ミント、バスを積み上げ=アンバー)
    act = d["activity"]
    mx = d["max_activity"] or 1
    cw, ch, cx0, cy0 = W - 128, 74, 64, H - 118
    over = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    od = ImageDraw.Draw(over)
    xs = [cx0 + cw * i / (len(act) - 1) for i in range(len(act))]
    y_rail = [cy0 + ch - ch * a["rail"] / mx for a in act]
    y_tot = [cy0 + ch - ch * (a["rail"] + a["bus"]) / mx for a in act]
    S = lambda pts: [(x * SS, y * SS) for x, y in pts]
    od.rounded_rectangle([(cx0 - 14) * SS, (cy0 - 16) * SS, (cx0 + cw + 14) * SS, (cy0 + ch + 12) * SS],
                         radius=14 * SS, fill=(6, 9, 20, 228), outline=(255, 255, 255, 22), width=SS)
    for i in range(1, 4):
        gx = (cx0 + cw * i / 4) * SS
        od.line([(gx, (cy0 - 16) * SS), (gx, (cy0 + ch + 12) * SS)], fill=(255, 255, 255, 18), width=SS)
    od.polygon(S(list(zip(xs, y_tot)) + list(zip(xs, y_rail))[::-1]), fill=(251, 146, 60, 70))
    od.polygon(S(list(zip(xs, y_rail)) + [(xs[-1], cy0 + ch), (xs[0], cy0 + ch)]), fill=(94, 234, 212, 60))
    od.line(S(list(zip(xs, y_tot))), fill=(251, 146, 60, 255), width=2 * SS, joint="curve")
    od.line(S(list(zip(xs, y_rail))), fill=(94, 234, 212, 255), width=2 * SS, joint="curve")
    over = over.resize((W, H), Image.LANCZOS)
    glow = over.filter(ImageFilter.GaussianBlur(6))
    out = Image.alpha_composite(Image.alpha_composite(out.convert("RGBA"), glow), over)

    # 文字
    dr = ImageDraw.Draw(out)
    mono = font("consola.ttf", 15)
    x0 = 72

    def tracked(x, y, text, f, fill, track):
        for c in text:
            dr.text((x, y), c, font=f, fill=fill)
            x += dr.textlength(c, font=f) + track
        return x

    tracked(x0, 70, "PUBLIC TRANSIT · GTFS · 24 HOURS", mono, (139, 152, 173), 4)
    title = font("yumindb.ttf", 92)
    tracked(x0 - 4, 118, "都市の鼓動", title, (241, 245, 249), 16)
    dr.line([(x0, 262), (x0 + 36, 262)], fill=(94, 234, 212), width=1)
    end = tracked(x0 + 50, 252, "CITY PULSE", font("consola.ttf", 18), (94, 234, 212), 11)
    dr.line([(end + 4, 262), (end + 40, 262)], fill=(251, 146, 60), width=1)
    body = font("YuGothM.ttc", 23)
    dr.text((x0, 312), "時刻表データ(GTFS)から、", font=body, fill=(203, 213, 225))
    dr.text((x0, 348), "街の24時間の“鼓動”を3Dで鑑賞する。", font=body, fill=(203, 213, 225))
    small = font("consola.ttf", 14)
    for i, lab in enumerate(["00:00", "06:00", "12:00", "18:00", "24:00"]):
        lx = cx0 + cw * i / 4 - (0 if i == 0 else dr.textlength(lab, font=small) if i == 4 else dr.textlength(lab, font=small) / 2)
        dr.text((lx, cy0 - 38), lab, font=small, fill=(139, 152, 173))
    dr.text((W - 64 - dr.textlength("city-pulse-v0lm.onrender.com", font=small), H - 32),
            "city-pulse-v0lm.onrender.com", font=small, fill=(139, 152, 173))
    dr.text((cx0, H - 30), "Data: ODPT / Tokyo Metropolitan Bureau of Transportation (Toei) GTFS", font=font("consola.ttf", 12), fill=(86, 98, 122))

    out.convert("RGB").save(ROOT / "web" / "ogp.png", optimize=True)

    # ホーム画面アイコン(favicon.svg と同じ心電図のモチーフ)
    n = 180 * SS
    icon = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    idr = ImageDraw.Draw(icon)
    idr.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=BG + (255,))
    pts = [(6, 35), (21, 35), (25, 35), (29, 22), (34, 48), (39, 14), (43, 38), (46, 35), (58, 35)]
    pts = [(x / 64 * n, y / 64 * n) for x, y in pts]
    line = Image.new("L", (n, n), 0)
    ImageDraw.Draw(line).line(pts, fill=255, width=int(n * 0.07), joint="curve")
    grad = np.zeros((n, n, 4), dtype=np.uint8)
    t = np.clip((np.arange(n) / n - 0.15) / 0.7, 0, 1)[None, :, None]
    grad[..., :3] = (RAIL * (1 - t) + BUS * t).astype(np.uint8)
    grad[..., 3] = np.asarray(line)
    icon = Image.alpha_composite(icon, Image.fromarray(grad, "RGBA"))
    icon.resize((180, 180), Image.LANCZOS).convert("RGB").save(ROOT / "web" / "apple-touch-icon.png", optimize=True)
    print("saved web/ogp.png, web/apple-touch-icon.png")


if __name__ == "__main__":
    main()
