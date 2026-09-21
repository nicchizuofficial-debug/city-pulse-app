/* 建物データの取得。
 *  1) OpenStreetMap(Overpass API)の建物 … 範囲内の建物数に応じて「全建物 → 中層以上 → 高層以上 → 超高層」と自動で絞り込む
 *  2) OSMの建物がほとんど無い地域は、GTFSの運行頻度から作る 250m メッシュ(地域メッシュ準拠)で代替する
 *  PLATEAUは1タイルが約13MBと重く、ブラウザ内では扱えないため対象外。
 *  返す形式は東京サンプルの buildings_3d.json と同じ [{polygon:[[lon,lat],...], height}] で、光り方は全都市共通。 */
'use strict';

const BuildingLoader = (() => {
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const MAX_BUILDINGS = 90000;    // ブラウザで軽快に動かせる上限の目安
  const MIN_OSM_BUILDINGS = 1500; // これ未満ならOSMの建物は無いものとしてメッシュにする
  const LEVEL_HEIGHT_M = 3.5;

  const FILTERS = [
    { id: 'all', label: 'すべての建物', levels: null, height: null },
    { id: 'mid', label: '中層以上(3階建て以上)', levels: '^([3-9]|[1-9][0-9]+)$', height: '^([89]|[1-9][0-9]|[1-9][0-9]{2,})(\\.[0-9]+)?\\s?m?$' },
    { id: 'high', label: '高層以上(5階建て以上)', levels: '^([5-9]|[1-9][0-9]+)$', height: '^([1-9][0-9]|[1-9][0-9]{2,})(\\.[0-9]+)?\\s?m?$' },
    { id: 'tall', label: '超高層(8階建て以上)', levels: '^([89]|[1-9][0-9]+)$', height: '^(2[5-9]|[3-9][0-9]|[1-9][0-9]{2,})(\\.[0-9]+)?\\s?m?$' },
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function overpass(query, timeoutMs = 180000, attempts = 4) {
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const url = ENDPOINTS[attempt >= 2 ? attempt % ENDPOINTS.length : 0];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        if (res.ok) {
          const j = await res.json();
          // Overpassはメモリ不足・時間切れでもHTTP 200で"remark"に理由を入れて返すことがある
          if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark)) {
            const err = new Error('Overpass: ' + j.remark);
            err.fatal = true;
            throw err;
          }
          return j;
        }
        lastErr = new Error('Overpass HTTP ' + res.status);
        if (res.status === 429 || res.status >= 500) { await sleep(4000 * (attempt + 1)); continue; }
        throw lastErr;
      } catch (e) {
        if (e && e.fatal) throw e;
        lastErr = (e && e.name === 'AbortError') ? new Error('Overpass APIの応答が時間内に返りませんでした(混雑中の可能性があります)') : e;
        await sleep(2500 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('Overpass request failed');
  }

  function stmt(filter, bbox) {
    const b = `(${bbox.s},${bbox.w},${bbox.n},${bbox.e})`;
    if (!filter.levels) return `way["building"]${b};`;
    return `way["building"]["building:levels"~"${filter.levels}"]${b};way["building"]["height"~"${filter.height}"]${b};`;
  }

  // Overpass APIに繋がるかを短時間で確かめる(繋がらない/混雑で応答しない場合はOSMを諦めてメッシュにする)
  async function ping() {
    try {
      await overpass('[out:json][timeout:15];node(35.68,139.76,35.6801,139.7601);out count;', 25000, 2);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function countBuildings(filter, bbox) {
    try {
      const j = await overpass(`[out:json][timeout:90];(${stmt(filter, bbox)});out count;`, 110000, 2);
      const el = j.elements && j.elements[0];
      return el && el.tags ? parseInt(el.tags.ways, 10) : Infinity;
    } catch (e) {
      return Infinity;   // 数えられないほど多い → 次の(より絞った)段階へ
    }
  }

  function heightOf(tags, polygon) {
    if (tags) {
      const h = parseFloat(String(tags.height || '').replace('m', ''));
      if (isFinite(h) && h >= 3) return h;
      const lv = parseFloat(tags['building:levels']);
      if (isFinite(lv) && lv * LEVEL_HEIGHT_M >= 3) return lv * LEVEL_HEIGHT_M;
    }
    // 高さ情報が無い建物は、敷地の広さから大まかに推定する(広いほど高め)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of polygon) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const midLat = (minY + maxY) / 2;
    const areaM2 = (maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180) * (maxY - minY) * 110540 * 0.7;
    return Math.round(Math.min(30, 6 + Math.sqrt(Math.max(areaM2, 0)) * 0.25) * 10) / 10;
  }

  // 1区画を取得する。タイムアウト等で失敗したら4分割して取り直す(最大2段階)
  async function fetchCell(filter, cell, depth, seen, out, stats) {
    let j;
    try {
      j = await overpass(`[out:json][timeout:150];(${stmt(filter, cell)});out body geom qt;`, 180000, depth < 2 ? 2 : 3);
    } catch (e) {
      if (depth >= 2) {   // これ以上分割しても取れない区画は諦め、取得できた分で作成を続ける
        stats.failed++;
        console.warn('Overpass cell skipped:', e && e.message);
        return;
      }
      const mLat = (cell.s + cell.n) / 2, mLon = (cell.w + cell.e) / 2;
      for (const sub of [
        { s: cell.s, n: mLat, w: cell.w, e: mLon }, { s: cell.s, n: mLat, w: mLon, e: cell.e },
        { s: mLat, n: cell.n, w: cell.w, e: mLon }, { s: mLat, n: cell.n, w: mLon, e: cell.e },
      ]) await fetchCell(filter, sub, depth + 1, seen, out, stats);
      return;
    }
    ingest(j, seen, out);
  }

  function ingest(j, seen, out) {
    for (const el of j.elements || []) {
      if (el.type !== 'way' || seen.has(el.id) || !el.geometry || el.geometry.length < 3) continue;
      seen.add(el.id);
      const polygon = el.geometry.map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]);
      const a = polygon[0], z = polygon[polygon.length - 1];
      if (a[0] !== z[0] || a[1] !== z[1]) polygon.push([a[0], a[1]]);
      out.push({ polygon, height: heightOf(el.tags, polygon) });
    }
  }

  // JRが通る場所(停留所の周囲約450m四方)の建物を、すべて取得する。範囲(boxes)はまとめて1回のクエリにする
  const CORRIDOR_CELL_DEG = 0.004;
  const CORRIDOR_MAX_BOXES = 200;

  function corridorBoxes(points, center) {
    const cells = new Map();
    for (const [lon, lat] of points) {
      const gx = Math.floor(lon / CORRIDOR_CELL_DEG), gy = Math.floor(lat / CORRIDOR_CELL_DEG);
      cells.set(gx + '_' + gy, [gx, gy]);
    }
    const pad = 0.001;
    return [...cells.values()]
      .map(([gx, gy]) => ({
        s: gy * CORRIDOR_CELL_DEG - pad, n: (gy + 1) * CORRIDOR_CELL_DEG + pad,
        w: gx * CORRIDOR_CELL_DEG - pad, e: (gx + 1) * CORRIDOR_CELL_DEG + pad,
      }))
      .sort((a, b) => Math.hypot((a.w + a.e) / 2 - center[0], (a.s + a.n) / 2 - center[1]) - Math.hypot((b.w + b.e) / 2 - center[0], (b.s + b.n) / 2 - center[1]))
      .slice(0, CORRIDOR_MAX_BOXES);
  }

  async function fetchBoxChunk(boxes, depth, seen, out, stats) {
    try {
      const j = await overpass(`[out:json][timeout:150];(${boxes.map((b) => stmt(FILTERS[0], b)).join('')});out body geom qt;`, 180000, depth < 2 ? 2 : 3);
      ingest(j, seen, out);
    } catch (e) {
      if (depth >= 2 || boxes.length === 1) { stats.failed++; return; }
      const half = Math.ceil(boxes.length / 2);
      await fetchBoxChunk(boxes.slice(0, half), depth + 1, seen, out, stats);
      await fetchBoxChunk(boxes.slice(half), depth + 1, seen, out, stats);
    }
  }

  async function fetchBoxes(boxes, budget, onProgress, seen, stats) {
    const out = [];
    const CHUNK = 16;
    for (let i = 0; i < boxes.length && out.length < budget; i += CHUNK) {
      onProgress(i / boxes.length, `JRが通る場所の建物を取得中… (${Math.min(i + CHUNK, boxes.length)}/${boxes.length}区画)`);
      await fetchBoxChunk(boxes.slice(i, i + CHUNK), 0, seen, out, stats);
    }
    onProgress(1, 'JRが通る場所の建物を取得中…');
    return out;
  }

  async function fetchOsm(filter, bbox, expected, onProgress, seen, stats) {
    const n = Math.max(1, Math.min(7, Math.ceil(Math.sqrt(expected / 10000))));
    const out = [];
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const cell = {
          s: bbox.s + (bbox.n - bbox.s) * iy / n, n: bbox.s + (bbox.n - bbox.s) * (iy + 1) / n,
          w: bbox.w + (bbox.e - bbox.w) * ix / n, e: bbox.w + (bbox.e - bbox.w) * (ix + 1) / n,
        };
        onProgress((iy * n + ix) / (n * n), `建物データを取得中… (${iy * n + ix + 1}/${n * n})`);
        await fetchCell(filter, cell, 0, seen, out, stats);
      }
    }
    onProgress(1, '建物データを取得中…');
    return out;
  }

  /* OSM由来のベクトルタイル(OpenFreeMap・OpenMapTiles形式)から建物を取り出す。
   * Overpass APIが混雑・停止していても使える。高さはタイルの render_height。
   * 中心に近いタイルは細かい建物まで、離れるほど高い建物だけを残して、全体を上限以内に収める。 */
  const TILE_ZOOM = 14;
  const MAX_TILES = 160;
  const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

  async function fetchTile(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.status === 404) return null;   // データの無いタイル
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (attempt === 1) return undefined;   // 取得失敗(飛ばす)
        await sleep(800);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function loadOsmTiles(bbox, center, onProgress, extraPoints = []) {
    let tmpl;
    try {
      tmpl = (await (await fetch(TILEJSON_URL)).json()).tiles[0];
    } catch (e) {
      return null;
    }
    const n = Math.pow(2, TILE_ZOOM);
    const lonToX = (lon) => Math.floor((lon + 180) / 360 * n);
    const latToY = (lat) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    const x0 = lonToX(bbox.w), x1 = lonToX(bbox.e), y0 = latToY(bbox.n), y1 = latToY(bbox.s);
    const cx = (lonToX(center[0]) + 0.5), cy = (latToY(center[1]) + 0.5);
    // JRが通るタイル(とその周囲)は、範囲の端でも必ず含め、細かい建物まで残す
    const jrTiles = new Set();
    for (const [lon, lat] of extraPoints) {
      const tx = lonToX(lon), ty = latToY(lat);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) jrTiles.add((tx + dx) + '_' + (ty + dy));
    }
    let tiles = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ x, y, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy), jr: jrTiles.has(x + '_' + y) });
    tiles.sort((a, b) => a.d - b.d);
    const jrFirst = tiles.filter((t) => t.jr).slice(0, MAX_TILES);
    const others = tiles.filter((t) => !t.jr);
    tiles = [...jrFirst, ...others].slice(0, MAX_TILES).sort((a, b) => a.d - b.d);
    const dMax = Math.max(1, tiles[tiles.length - 1].d);

    const tileLon = (tx, u) => (tx + u) / n * 360 - 180;
    const tileLat = (ty, v) => Math.atan(Math.sinh(Math.PI - 2 * Math.PI * (ty + v) / n)) * 180 / Math.PI;
    const r6 = (v) => Math.round(v * 1e6) / 1e6;

    const out = [];
    let done = 0, failed = 0, next = 0;
    async function worker() {
      while (next < tiles.length) {
        const rank = next++;
        const t = tiles[rank];
        const bytes = await fetchTile(tmpl.replace('{z}', TILE_ZOOM).replace('{x}', t.x).replace('{y}', t.y));
        done++;
        onProgress(done / tiles.length, `建物データを取得中… (${done}/${tiles.length}タイル)`);
        if (bytes === undefined) { failed++; continue; }
        if (!bytes) continue;
        const layer = MVT.decodeLayer(bytes, 'building');
        const ext = layer.extent || 4096;
        const midLat = tileLat(t.y, 0.5);
        const m2PerUnit2 = Math.pow(40075016.686 * Math.cos(midLat * Math.PI / 180) / n / ext, 2);
        // 近いタイルほど細かい建物まで残す(近: 25㎡以上 / 中: 高さ6m以上か150㎡以上 / 遠: 高さ12m以上)
        const near = t.jr || rank < 45, mid = t.jr || rank < 100;
        for (const f of layer.features) {
          const h = f.props.render_height;
          for (const ring of f.rings) {
            if (ring.length < 4) continue;
            let s = 0;
            for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            if (s <= 0) continue;   // 内側の輪(中庭など)は使わない
            const area = s / 2 * m2PerUnit2;
            const height = h > 0 ? h : Math.min(30, 6 + Math.sqrt(area) * 0.25);
            if (near ? area < 25 : mid ? !(height >= 6 || area >= 150) : height < 12) continue;
            out.push({
              polygon: ring.map(([x, y]) => [r6(tileLon(t.x, x / ext)), r6(tileLat(t.y, y / ext))]),
              height: Math.round(height * 10) / 10,
              score: height + 30 * (1 - t.d / dMax) + (t.jr ? 40 : 0),
            });
          }
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));

    let buildings = out;
    if (buildings.length > MAX_BUILDINGS) {
      buildings.sort((a, b) => b.score - a.score);
      buildings = buildings.slice(0, MAX_BUILDINGS);
    }
    buildings.forEach((b) => { delete b.score; });
    return { buildings, tiles: tiles.length, failed };
  }

  // 地域メッシュ(5次メッシュ相当・約250m: 緯度7.5秒×経度11.25秒)に沿った格子を、運行頻度で立ち上げる
  function buildMesh(stopHeat, bbox) {
    const LAT_STEP = 7.5 / 3600, LON_STEP = 11.25 / 3600;
    const cells = new Map();
    const add = (gy, gx, w) => { const k = gy + '_' + gx; cells.set(k, (cells.get(k) || 0) + w); };
    for (const [lon, lat, w] of stopHeat) {
      const gy = Math.floor(lat / LAT_STEP), gx = Math.floor(lon / LON_STEP);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(gy + dy, gx + dx, dx === 0 && dy === 0 ? w : w * 0.35);
    }
    let maxW = 1;
    for (const v of cells.values()) if (v > maxW) maxW = v;
    const inset = 0.08;
    const out = [];
    for (const [k, v] of cells) {
      const [gy, gx] = k.split('_').map(Number);
      const s = gy * LAT_STEP, w = gx * LON_STEP;
      if (s < bbox.s || s + LAT_STEP > bbox.n || w < bbox.w || w + LON_STEP > bbox.e) continue;
      const dl = LAT_STEP * inset, dn = LON_STEP * inset;
      const r = (x) => Math.round(x * 1e6) / 1e6;
      out.push({
        polygon: [[r(w + dn), r(s + dl)], [r(w + LON_STEP - dn), r(s + dl)], [r(w + LON_STEP - dn), r(s + LAT_STEP - dl)], [r(w + dn), r(s + LAT_STEP - dl)], [r(w + dn), r(s + dl)]],
        height: Math.round((8 + 130 * Math.pow(v / maxW, 0.6)) * 10) / 10,
      });
    }
    return out;
  }

  function scaleBbox(bbox, center, s) {
    const hLat = (bbox.n - bbox.s) / 2 * s, hLon = (bbox.e - bbox.w) / 2 * s;
    return {
      s: Math.max(bbox.s, center[1] - hLat), n: Math.min(bbox.n, center[1] + hLat),
      w: Math.max(bbox.w, center[0] - hLon), e: Math.min(bbox.e, center[0] + hLon),
    };
  }

  /* 取得計画を立てる。
   *  ・全建物が上限以内 → 範囲全体の全建物
   *  ・多すぎる → 範囲全体は「タグ付き(中層以上など)」に絞り、余力があれば中心部だけ「全建物」を重ねる
   *  ・どれでも収まらない/建物が無い → null(メッシュで代替) */
  async function plan(bbox, center, onProgress) {
    onProgress(0, 'OpenStreetMapの建物数を確認中…');
    const allCount = await countBuildings(FILTERS[0], bbox);
    if (allCount < MIN_OSM_BUILDINGS) return null;
    if (allCount <= MAX_BUILDINGS) return [{ filter: FILTERS[0], bbox, expected: allCount, label: 'すべての建物' }];

    let tag = null, tagCount = 0;
    for (let i = 1; i < FILTERS.length; i++) {
      onProgress(0, `建物が多いため絞り込み中… (${FILTERS[i - 1].label}: ${Number.isFinite(allCount) && i === 1 ? allCount.toLocaleString() + '棟' : '多数'})`);
      const c = await countBuildings(FILTERS[i], bbox);
      if (c <= MAX_BUILDINGS) { tag = FILTERS[i]; tagCount = c; break; }
    }
    if (!tag) return null;
    const steps = [{ filter: tag, bbox, expected: tagCount, label: `範囲全体: ${tag.label}` }];

    const headroom = MAX_BUILDINGS - tagCount;
    if (headroom > 15000 && Number.isFinite(allCount)) {
      let s = Math.min(0.7, Math.max(0.12, Math.sqrt(0.7 * headroom / allCount)));
      for (let k = 0; k < 3; k++) {
        const core = scaleBbox(bbox, center, s);
        onProgress(0, '中心部の建物数を確認中…');
        const cc = await countBuildings(FILTERS[0], core);
        if (cc <= headroom) { steps.push({ filter: FILTERS[0], bbox: core, expected: cc, label: '中心部: すべての建物' }); break; }
        s *= Number.isFinite(cc) ? Math.sqrt(0.85 * headroom / Math.max(cc, 1)) : 0.5;
        if (s < 0.08) break;
      }
    }
    return steps;
  }

  /* 範囲(bbox)の建物を返す。 戻り値: { buildings, source: 'osm'|'mesh', detail } */
  async function load({ bbox, stopHeat, center, extraPoints = [] }, onProgress) {
    let steps = null;
    let osmFailed = false;
    onProgress(0, 'OpenStreetMap(Overpass API)に接続中…');
    if (!(await ping())) {
      osmFailed = true;
      steps = null;
    } else {
      steps = await plan(bbox, center || [(bbox.w + bbox.e) / 2, (bbox.s + bbox.n) / 2], onProgress);
    }
    if (steps) {
      const seen = new Set();
      const stats = { failed: 0 };
      const all = [];
      const parts = [];
      // 範囲全体を「タグ付きの建物」に絞っている場合でも、JRが通る場所はすべての建物を出す
      const ctr = center || [(bbox.w + bbox.e) / 2, (bbox.s + bbox.n) / 2];
      if (extraPoints.length && steps[0].filter.id !== 'all') {
        steps.push({ corridor: true, boxes: corridorBoxes(extraPoints, ctr), label: 'JR沿線: すべての建物' });
      }
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const prog = (fr, text) => onProgress((i + fr) / steps.length, text);
        const got = st.corridor
          ? await fetchBoxes(st.boxes, Math.max(0, MAX_BUILDINGS * 1.15 - all.length), prog, seen, stats)
          : await fetchOsm(st.filter, st.bbox, st.expected, prog, seen, stats);
        all.push(...got);
        parts.push(`${st.label} ${got.length.toLocaleString()}棟`);
      }
      if (all.length >= MIN_OSM_BUILDINGS) {
        const note = stats.failed ? ` ※混雑で取得できなかった区画が${stats.failed}か所あります` : '';
        return { buildings: all, source: 'osm', detail: `OpenStreetMap(${parts.join(' + ')})${note}` };
      }
      osmFailed = stats.failed > 0;
    }

    // Overpass APIが使えない/建物が足りない場合は、同じOSM由来のベクトルタイル(OpenFreeMap)から取得する
    onProgress(0, osmFailed ? 'Overpass APIが混雑しているため、別経路(OpenFreeMap)でOSMの建物を取得中…' : 'OSMのベクトルタイルで建物を確認中…');
    try {
      const t = await loadOsmTiles(bbox, center || [(bbox.w + bbox.e) / 2, (bbox.s + bbox.n) / 2], onProgress, extraPoints);
      if (t && t.buildings.length >= MIN_OSM_BUILDINGS) {
        const note = t.failed ? ` ※取得できなかったタイルが${t.failed}個あります` : '';
        return {
          buildings: t.buildings, source: 'osm',
          detail: `OpenStreetMap(ベクトルタイル・中心部は詳細/周辺は高い建物中心) ${t.buildings.length.toLocaleString()}棟${note}`,
        };
      }
    } catch (e) {
      console.warn('OSM tile fallback failed:', e && e.message);
    }

    onProgress(0.5, 'OSMの建物が少ないため、メッシュで代替中…');
    const buildings = buildMesh(stopHeat, bbox);
    const why = osmFailed ? ' ※OSM取得に失敗したため代替' : '';
    return { buildings, source: 'mesh', detail: `250mメッシュ(運行頻度) ${buildings.length.toLocaleString()}セル${why}` };
  }

  return { load, buildMesh };
})();
