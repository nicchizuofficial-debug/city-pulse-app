/* GTFS zip → 都市の鼓動用データ(運行アニメーション+鼓動ヒストグラム)をブラウザ内で生成するWorker。
 * GTFSはサーバーへ送らず、この端末内だけで処理する。 */
'use strict';
importScripts('/static/vendor/fflate.min.js');

const DAY_SEC = 86400;
const BUCKET_SEC = 300;
const MAX_TRIPS = 22000;               // 描画負荷を抑えるための便数上限(超える分は間引く)
const MAX_HALF_LAT = 0.11;             // 対象範囲の最大半幅(緯度方向, 約12km)
const MIN_HALF_LAT = 0.035;
const RANDOM_SEED = 42;

self.onmessage = async (e) => {
  try {
    const result = await build(e.data.files, e.data.modes);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

function progress(stage, frac, msg) {
  self.postMessage({ type: 'progress', stage, frac, msg });
}

/* ---------------- zip / csv ---------------- */

function parseCsvLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function csv(cb) {
  let col = null;
  return (line) => {
    const f = parseCsvLine(line);
    if (!col) {
      col = {};
      for (let i = 0; i < f.length; i++) col[f[i].trim()] = i;
      return;
    }
    cb(f, col);
  };
}

function feedLines(handler, text, state, final) {
  text = state.carry + text;
  let start = 0, idx;
  while ((idx = text.indexOf('\n', start)) !== -1) {
    let line = text.slice(start, idx);
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (line.length) handler(line);
    start = idx + 1;
  }
  state.carry = text.slice(start);
  if (final && state.carry.length) {
    const l = state.carry.replace(/\r$/, '');
    if (l.length) handler(l);
    state.carry = '';
  }
}

const baseName = (n) => n.split('/').pop().toLowerCase();

async function streamZip(file, handlers, onFrac) {
  const unzip = new fflate.Unzip();
  unzip.register(fflate.UnzipInflate);
  let failure = null;
  unzip.onfile = (f) => {
    const h = handlers[baseName(f.name)];
    if (!h) return;
    const dec = new TextDecoder('utf-8');
    const state = { carry: '', first: true };
    f.ondata = (err, chunk, final) => {
      if (err) { failure = err; return; }
      let text = dec.decode(chunk, { stream: !final });
      if (state.first && text.length) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        state.first = false;
      }
      feedLines(h, text, state, final);
    };
    f.start();
  };
  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    unzip.push(value, false);
    read += value.length;
    if (onFrac) onFrac(read / file.size);
    if (failure) throw failure;
  }
  unzip.push(new Uint8Array(0), true);
  if (failure) throw failure;
}

async function streamZipSafe(file, handlers, onFrac) {
  try {
    await streamZip(file, handlers, onFrac);
  } catch (err) {
    // ストリーム展開できない形式のzip向けフォールバック(メモリを多く使う)
    const u8 = new Uint8Array(await file.arrayBuffer());
    const files = fflate.unzipSync(u8, { filter: (f) => !!handlers[baseName(f.name)] });
    for (const name of Object.keys(files)) {
      const h = handlers[baseName(name)];
      const dec = new TextDecoder('utf-8');
      let text = dec.decode(files[name]);
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      feedLines(h, text, { carry: '' }, true);
    }
  }
}

/* ---------------- 補助関数 ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ymdToMs(s) {
  const n = parseInt(s, 10);
  if (!(n > 19000101)) return NaN;
  return Date.UTC(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100);
}

function timeToSec(s) {
  if (!s) return -1;
  const a = s.indexOf(':');
  if (a < 0) return -1;
  const b = s.indexOf(':', a + 1);
  const h = parseInt(s.slice(0, a), 10);
  const m = parseInt(s.slice(a + 1, b < 0 ? undefined : b), 10);
  const sec = b < 0 ? 0 : parseInt(s.slice(b + 1), 10);
  if (!isFinite(h) || !isFinite(m)) return -1;
  return h * 3600 + m * 60 + (isFinite(sec) ? sec : 0);
}


// route_type → 鉄道系('rail') / バス系('bus')。GTFS拡張種別(200番台=コーチ、700〜800番台=バス・トロリーバス)も含む
function modeOf(routeType) {
  if (routeType === 3 || routeType === 11 || (routeType >= 200 && routeType < 300) || (routeType >= 700 && routeType < 900)) return 'bus';
  return 'rail';
}

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/* ---------------- 1つのGTFSを読む ---------------- */

async function readFeed(file, fi, nFeeds) {
  if (!file || !file.size) throw new Error(`${file ? file.name : 'ファイル'} が空です`);
  const label = nFeeds > 1 ? `(${fi + 1}/${nFeeds}) ${file.name}` : file.name;
  const prog = (frac) => progress('read', (fi + frac) / nFeeds, `GTFSを読み込み中… ${label}`);
  prog(0);

  const stopIdx = new Map();
  const stopLat = [], stopLon = [];
  const routes = new Map();
  const tripIdx = new Map();
  const tripRoute = [], tripService = [];
  const calendar = new Map();
  const calDates = [];
  let agencyName = '';

  const small = {
    'stops.txt': csv((f, c) => {
      const lat = parseFloat(f[c.stop_lat]), lon = parseFloat(f[c.stop_lon]);
      if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return;
      stopIdx.set(f[c.stop_id], stopLat.length);
      stopLat.push(lat); stopLon.push(lon);
    }),
    'routes.txt': csv((f, c) => {
      const type = parseInt(f[c.route_type], 10);
      const name = (c.route_long_name !== undefined && f[c.route_long_name]) || (c.route_short_name !== undefined && f[c.route_short_name]) || f[c.route_id];
      routes.set(f[c.route_id], { type: isFinite(type) ? type : 2, name });
    }),
    'trips.txt': csv((f, c) => {
      tripIdx.set(f[c.trip_id], tripRoute.length);
      tripRoute.push(f[c.route_id]);
      tripService.push(f[c.service_id]);
    }),
    'calendar.txt': csv((f, c) => {
      calendar.set(f[c.service_id], {
        dow: [f[c.sunday], f[c.monday], f[c.tuesday], f[c.wednesday], f[c.thursday], f[c.friday], f[c.saturday]].map((v) => v === '1'),
        start: ymdToMs(f[c.start_date]), end: ymdToMs(f[c.end_date]),
      });
    }),
    'calendar_dates.txt': csv((f, c) => {
      calDates.push({ svc: f[c.service_id], ms: ymdToMs(f[c.date]), type: f[c.exception_type] });
    }),
    'agency.txt': csv((f, c) => { if (!agencyName && c.agency_name !== undefined) agencyName = f[c.agency_name]; }),
  };
  await streamZipSafe(file, small, prog);

  if (!stopLat.length) throw new Error(`${file.name}: stops.txt が見つからない、または停留所が0件です(GTFSのzipか確認してください)`);
  if (!tripRoute.length) throw new Error(`${file.name}: trips.txt が見つからない、または便が0件です`);

  /* 代表的な平日ダイヤの運行日を決める(火〜木のうち運行便数が最大の日) */
  const svcTrips = new Map();
  for (const s of tripService) svcTrips.set(s, (svcTrips.get(s) || 0) + 1);
  const addRemove = new Map();
  for (const cd of calDates) {
    if (!isFinite(cd.ms)) continue;
    let arr = addRemove.get(cd.ms);
    if (!arr) { arr = []; addRemove.set(cd.ms, arr); }
    arr.push(cd);
  }
  let minMs = Infinity, maxMs = -Infinity;
  for (const s of calendar.values()) {
    if (isFinite(s.start)) minMs = Math.min(minMs, s.start);
    if (isFinite(s.end)) maxMs = Math.max(maxMs, s.end);
  }
  for (const ms of addRemove.keys()) { minMs = Math.min(minMs, ms); maxMs = Math.max(maxMs, ms); }
  if (!isFinite(minMs)) throw new Error(`${file.name}: calendar.txt / calendar_dates.txt に運行日の情報がありません`);

  const DAY_MS = 86400000;
  function activeOn(ms) {
    const dow = new Date(ms).getUTCDay();
    const set = new Set();
    for (const [svc, s] of calendar) {
      if (ms >= s.start && ms <= s.end && s.dow[dow]) set.add(svc);
    }
    const ex = addRemove.get(ms);
    if (ex) for (const cd of ex) { if (cd.type === '1') set.add(cd.svc); else if (cd.type === '2') set.delete(cd.svc); }
    return set;
  }
  function pickDate(weekdayOnly) {
    let best = null, bestCount = 0, bestSet = null;
    for (let ms = minMs; ms <= Math.min(maxMs, minMs + 1100 * DAY_MS); ms += DAY_MS) {
      if (weekdayOnly) { const d = new Date(ms).getUTCDay(); if (d < 2 || d > 4) continue; }
      const set = activeOn(ms);
      let cnt = 0;
      for (const s of set) cnt += svcTrips.get(s) || 0;
      if (cnt > bestCount) { best = ms; bestCount = cnt; bestSet = set; }
    }
    return { best, bestSet };
  }
  let { best: serviceMs, bestSet: activeServices } = pickDate(true);
  if (!serviceMs) ({ best: serviceMs, bestSet: activeServices } = pickDate(false));
  if (!serviceMs) throw new Error(`${file.name}: 運行日を特定できませんでした(calendarの期間を確認してください)`);

  const activeTrip = new Uint8Array(tripRoute.length);
  for (let i = 0; i < tripRoute.length; i++) if (activeServices.has(tripService[i])) activeTrip[i] = 1;

  return {
    file, label, agencyName, stopIdx, stopLat, stopLon, routes, tripIdx, tripRoute, activeTrip,
    // JR(関東一円に路線が広がる)は、街の範囲や建物の範囲を決めるためには使わず、範囲内の運行だけを重ねる
    supplement: /JR|東日本旅客/.test(agencyName),
    serviceDate: new Date(serviceMs).toISOString().slice(0, 10),
  };
}

/* ---------------- 対象エリア(ウィンドウ)の決定: 全GTFSの停留所をまとめて判定 ---------------- */

function chooseWindow(feeds) {
  let nStops = 0;
  for (const f of feeds) nStops += f.stopLat.length;
  const allLat = new Float64Array(nStops), allLon = new Float64Array(nStops);
  let k = 0;
  for (const f of feeds) for (let i = 0; i < f.stopLat.length; i++, k++) { allLat[k] = f.stopLat[i]; allLon[k] = f.stopLon[i]; }
  const sortedLat = Float64Array.from(allLat).sort();
  const sortedLon = Float64Array.from(allLon).sort();

  let s = quantile(sortedLat, 0.02), n = quantile(sortedLat, 0.98);
  let w = quantile(sortedLon, 0.02), e = quantile(sortedLon, 0.98);
  let cLat = (s + n) / 2, cLon = (w + e) / 2;
  let hLat = (n - s) / 2 * 1.12 + 0.008;
  const cosLat = () => Math.max(0.2, Math.cos(cLat * Math.PI / 180));
  let hLon = (e - w) / 2 * 1.12 + 0.008 / cosLat();
  if (hLat > MAX_HALF_LAT || hLon > MAX_HALF_LAT / cosLat()) {
    // 路線網が広すぎる(全国フィードなど): 停留所が最も密集する場所を中心にする
    const cell = 0.02;
    const counts = new Map();
    for (let i = 0; i < nStops; i++) {
      const key = Math.floor(allLat[i] / cell) + '_' + Math.floor(allLon[i] / cell);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bestKey = null, bestScore = -1;
    for (const key of counts.keys()) {
      const [gy, gx] = key.split('_').map(Number);
      let score = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) score += counts.get((gy + dy) + '_' + (gx + dx)) || 0;
      if (score > bestScore) { bestScore = score; bestKey = key; }
    }
    const [gy, gx] = bestKey.split('_').map(Number);
    cLat = (gy + 0.5) * cell; cLon = (gx + 0.5) * cell;
    hLat = MAX_HALF_LAT; hLon = MAX_HALF_LAT / cosLat();
  }
  hLat = Math.max(hLat, MIN_HALF_LAT);
  hLon = Math.max(hLon, MIN_HALF_LAT / cosLat());
  return { s: cLat - hLat, n: cLat + hLat, w: cLon - hLon, e: cLon + hLon };
}

/* ---------------- メイン処理 ---------------- */

async function build(files, modes) {
  if (!files || !files.length) throw new Error('GTFSファイルが選ばれていません');
  const nFeeds = files.length;

  /* 1. すべてのGTFSの小さいテーブルを読む */
  const feeds = [];
  for (let fi = 0; fi < nFeeds; fi++) feeds.push(await readFeed(files[fi], fi, nFeeds));

  /* 2. 対象エリアを決める(JR以外のGTFSだけで決める。JRしか無い場合はJRで決める) */
  const primary = feeds.filter((f) => !f.supplement);
  const areaFeeds = primary.length ? primary : feeds;
  const win = chooseWindow(areaFeeds);
  for (const f of feeds) {
    f.inWin = new Uint8Array(f.stopLat.length);
    for (let i = 0; i < f.stopLat.length; i++) {
      if (f.stopLat[i] >= win.s && f.stopLat[i] <= win.n && f.stopLon[i] >= win.w && f.stopLon[i] <= win.e) f.inWin[i] = 1;
    }
  }

  // 鉄道/バスの区分: ファイルごとの指定('rail'/'bus')があればそれを優先し、'auto'ならroute_typeで判定
  const modeOfTrip = (fi, ti) => {
    const m = modes && modes[fi];
    if (m === 'rail' || m === 'bus') return m;
    const r = feeds[fi].routes.get(feeds[fi].tripRoute[ti]);
    return modeOf(r ? r.type : 2);
  };

  /* 3. stop_times 1周目: 対象エリアを通る便を特定 */
  const hitRail = [], hitBus = [];   // [fi, ti]
  for (let fi = 0; fi < nFeeds; fi++) {
    const f = feeds[fi];
    const tripHit = new Uint8Array(f.tripRoute.length);
    progress('scan', fi / nFeeds, `運行データを走査中… ${f.label}`);
    await streamZipSafe(f.file, {
      'stop_times.txt': csv((row, c) => {
        const ti = f.tripIdx.get(row[c.trip_id]);
        if (ti === undefined || !f.activeTrip[ti] || tripHit[ti]) return;
        const si = f.stopIdx.get(row[c.stop_id]);
        if (si !== undefined && f.inWin[si]) tripHit[ti] = 1;
      }),
    }, (fr) => progress('scan', (fi + fr) / nFeeds, `運行データを走査中… ${f.label}`));
    for (let ti = 0; ti < tripHit.length; ti++) {
      if (tripHit[ti]) (modeOfTrip(fi, ti) === 'bus' ? hitBus : hitRail).push([fi, ti]);
    }
  }
  if (hitRail.length + hitBus.length === 0) throw new Error('対象エリア内を通る便が見つかりませんでした(運行日・座標を確認してください)');

  // 便数が多すぎる場合は間引く(鉄道を優先して残し、バスを間引く)
  const railRate = Math.min(1, MAX_TRIPS / Math.max(1, hitRail.length));
  const busRate = Math.min(1, Math.max(0.05, (MAX_TRIPS - Math.min(hitRail.length, MAX_TRIPS)) / Math.max(1, hitBus.length)));
  const rng = mulberry32(RANDOM_SEED);
  const keeps = feeds.map((f) => new Uint8Array(f.tripRoute.length));
  for (const [fi, ti] of hitRail) if (rng() < railRate) keeps[fi][ti] = 1;
  for (const [fi, ti] of hitBus) if (rng() < busRate) keeps[fi][ti] = 1;

  /* 4. stop_times 2周目: 対象便の停車時刻を集め、便ごとに経路と時刻を組み立てる */
  const trips = [];
  const stopVisits = new Map();   // "lon,lat" → [lon, lat, 通過便数]  (メッシュ・建物用。JRの通る場所も含む)
  const viewVisits = new Map();   // "lon,lat" → [lon, lat]  (カメラの表示範囲用。JR以外のGTFSのみ)
  const nBuckets = DAY_SEC / BUCKET_SEC;
  const diffRail = new Int32Array(nBuckets + 1), diffBus = new Int32Array(nBuckets + 1);

  for (let fi = 0; fi < nFeeds; fi++) {
    const f = feeds[fi], keep = keeps[fi];
    const rows = new Map();
    progress('collect', fi / nFeeds, `停車時刻を集計中… ${f.label}`);
    await streamZipSafe(f.file, {
      'stop_times.txt': csv((row, c) => {
        const ti = f.tripIdx.get(row[c.trip_id]);
        if (ti === undefined || !keep[ti]) return;
        let r = rows.get(ti);
        if (!r) { r = { seq: [], st: [], t: [] }; rows.set(ti, r); }
        const si = f.stopIdx.get(row[c.stop_id]);
        let t = timeToSec(c.departure_time !== undefined ? row[c.departure_time] : '');
        if (t < 0) t = timeToSec(c.arrival_time !== undefined ? row[c.arrival_time] : '');
        r.seq.push(parseInt(row[c.stop_sequence], 10) || 0);
        r.st.push(si === undefined ? -1 : si);
        r.t.push(t);
      }),
    }, (fr) => progress('collect', (fi + fr) / nFeeds, `停車時刻を集計中… ${f.label}`));

    let done = 0;
    for (const [ti, r] of rows) {
      if (++done % 2000 === 0) progress('build', (fi + done / rows.size) / nFeeds, `運行アニメーションを生成中… ${f.label}`);
      const m = r.seq.length;
      let order = null;
      for (let i = 1; i < m; i++) if (r.seq[i] < r.seq[i - 1]) { order = Array.from({ length: m }, (_, k) => k).sort((a, b) => r.seq[a] - r.seq[b]); break; }
      const st = order ? order.map((k) => r.st[k]) : r.st;
      const tt = order ? order.map((k) => r.t[k]) : r.t;

      // 時刻が空欄の停車駅は前後の時刻から直線補間する
      let first = -1, last = -1;
      for (let i = 0; i < m; i++) if (tt[i] >= 0) { if (first < 0) first = i; last = i; }
      if (first < 0 || first === last) continue;
      const tv = new Array(m).fill(NaN);
      let prev = first;
      tv[first] = tt[first];
      for (let i = first + 1; i <= last; i++) {
        if (tt[i] >= 0) {
          for (let k = prev + 1; k < i; k++) tv[k] = tt[prev] + (tt[i] - tt[prev]) * (k - prev) / (i - prev);
          tv[i] = tt[i];
          prev = i;
        }
      }

      const path = [], timestamps = [], usedStops = [];
      let lastT = -Infinity;
      for (let i = first; i <= last; i++) {
        const si = st[i];
        if (si < 0 || !f.inWin[si] || !isFinite(tv[i])) continue;
        const tsec = Math.max(Math.round(tv[i]), lastT);
        lastT = tsec;
        path.push([Math.round(f.stopLon[si] * 1e5) / 1e5, Math.round(f.stopLat[si] * 1e5) / 1e5]);
        timestamps.push(tsec);
        usedStops.push(si);
      }
      if (path.length < 2) continue;

      const route = f.routes.get(f.tripRoute[ti]);
      const mode = modeOfTrip(fi, ti);
      trips.push({ mode, route_name: route ? route.name : '?', path, timestamps });
      // メッシュ・建物の元になる停留所(stopVisits)には、JRの通る場所も含める。
      // カメラの表示範囲(viewVisits)は、JR以外のGTFSだけから集める。
      const primaryFeed = !f.supplement || !primary.length;
      for (const si of usedStops) {
        const lon = Math.round(f.stopLon[si] * 1e5) / 1e5, lat = Math.round(f.stopLat[si] * 1e5) / 1e5;
        const key = lon + ',' + lat;
        const v = stopVisits.get(key);
        if (v) v[2]++; else stopVisits.set(key, [lon, lat, 1]);
        if (primaryFeed && !viewVisits.has(key)) viewVisits.set(key, [lon, lat]);
      }

      const b0 = Math.floor(timestamps[0] / BUCKET_SEC);
      if (b0 < nBuckets) {
        const b1 = Math.min(nBuckets - 1, Math.floor(timestamps[timestamps.length - 1] / BUCKET_SEC));
        const diff = mode === 'rail' ? diffRail : diffBus;
        diff[Math.max(0, b0)] += 1;
        diff[b1 + 1] -= 1;
      }
    }
  }
  if (!trips.length) throw new Error('有効な運行データを組み立てられませんでした(stop_timesの時刻が空欄の可能性があります)');

  const activity = [];
  let ar = 0, ab = 0, maxCount = 1;
  for (let b = 0; b < nBuckets; b++) {
    ar += diffRail[b]; ab += diffBus[b];
    activity.push({ t: b * BUCKET_SEC, rail: ar, bus: ab, count: ar + ab });
    if (ar + ab > maxCount) maxCount = ar + ab;
  }

  /* 5. 表示範囲・メッシュ用の停留所ヒートを作る */
  const stopHeat = [...stopVisits.values()];
  const viewPts = viewVisits.size ? [...viewVisits.values()] : stopHeat;
  const vlat = viewPts.map((v) => v[1]).sort((a, b) => a - b);
  const vlon = viewPts.map((v) => v[0]).sort((a, b) => a - b);
  const vs = quantile(vlat, 0.03), vn = quantile(vlat, 0.97), vw = quantile(vlon, 0.03), ve = quantile(vlon, 0.97);
  const padLat = Math.max((vn - vs) * 0.08, 0.004), padLon = Math.max((ve - vw) * 0.08, 0.005);
  const viewBounds = [vw - padLon, vs - padLat, ve + padLon, vn + padLat];

  let railCount = 0, busCount = 0;
  for (const t of trips) t.mode === 'rail' ? railCount++ : busCount++;

  const serviceDates = [...new Set(feeds.map((f) => f.serviceDate))].sort();
  return {
    meta: {
      agencyName: [...new Set(feeds.map((f) => f.agencyName).filter(Boolean))].join(' + '),
      serviceDate: serviceDates.length === 1 ? serviceDates[0] : serviceDates.join(' / '),
      feedCount: nFeeds, railTrips: railCount, busTrips: busCount,
      sampledFrom: hitRail.length + hitBus.length,
      window: [win.w, win.s, win.e, win.n], viewBounds,
      center: [(viewBounds[0] + viewBounds[2]) / 2, (viewBounds[1] + viewBounds[3]) / 2],
    },
    pulseData: { duration_sec: DAY_SEC, bucket_sec: BUCKET_SEC, max_activity: maxCount, activity, trips },
    stopHeat,
  };
}
