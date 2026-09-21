/* ホーム画面: 東京サンプル / 作成済みの都市 / GTFSをアップロードして新しい都市をつくる */
'use strict';

const Home = (() => {
  const STEPS = [
    { key: 'read', label: 'GTFS読込', weight: 0.10 },
    { key: 'scan', label: '対象便の抽出', weight: 0.22 },
    { key: 'collect', label: '時刻の集計', weight: 0.22 },
    { key: 'build', label: '運行データ生成', weight: 0.08 },
    { key: 'jr', label: 'JR東日本', weight: 0.05 },
    { key: 'buildings', label: '建物データ', weight: 0.28 },
    { key: 'save', label: '保存', weight: 0.05 },
  ];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document.getElementById('home')) => root.querySelector(sel);

  let picked = [];   // [{ file, mode: 'auto'|'rail'|'bus' }]
  let busy = false;

  function html() {
    return `
    <div class="wrap">
      <div class="brand">
        <h1>都市の鼓動</h1>
        <div class="en">CITY PULSE</div>
        <p>時刻表データ(GTFS)から、街の24時間の“鼓動”をつくります。<br>GTFSを入れ替えれば、日本のほかの都市でも同じ表現で作れます。</p>
      </div>

      <h2>サンプル</h2>
      <div class="card">
        <div class="row">
          <div>
            <div class="city-name">東京23区</div>
            <div class="city-sub">都営地下鉄・都営バス・JR東日本 ／ 建物: OpenStreetMap(中高層)</div>
          </div>
          <div class="actions"><a class="btn primary" href="?city=tokyo">見る</a></div>
        </div>
      </div>

      <h2>作成した都市</h2>
      <div class="card" id="saved"><div class="empty">読み込み中…</div></div>

      <h2>新しい都市をつくる</h2>
      <div class="card">
        <div class="drop" id="drop">
          <div id="dropText"><b>GTFSのzipファイルをここにドロップ</b>(複数可)<br>またはタップして選択(.zip)<br><span class="hint">鉄道とバスなど、事業者ごとのGTFSを続けて追加すると1つの街として重ねます</span></div>
          <input type="file" id="file" accept=".zip,application/zip" multiple hidden>
        </div>
        <div class="files" id="files"></div>
        <label class="field">都市の名前(空欄ならGTFSの事業者名)
          <input type="text" id="cityName" placeholder="例: 京都市" maxlength="40">
        </label>
        <label class="check"><input type="checkbox" id="jrOpt" checked>
          <span>JR東日本の運行を重ねる<small>公共交通オープンデータチャレンジの提供データ。対象エリアにJRの運行がある場合のみ反映されます</small></span>
        </label>
        <div class="submit"><button class="btn primary" id="go" disabled>この街の鼓動をつくる</button></div>
        <div class="progress" id="progress">
          <div class="bar"><i id="barFill"></i></div>
          <div class="msg" id="msg"></div>
          <ul class="steps" id="steps">${STEPS.map((s) => `<li data-k="${s.key}">${s.label}</li>`).join('')}</ul>
        </div>
        <div class="error" id="error"></div>
      </div>

      <div class="note">
        <b>ご利用にあたって</b><br>
        ・GTFSの処理はすべてこの端末のブラウザ内で行い、GTFSファイルはサーバーへ送信されません。作成した都市もこの端末内にだけ保存されます。<br>
        ・運行は、GTFSから選んだ代表的な平日ダイヤ1日分です。<br>
        ・建物はOpenStreetMap(© OpenStreetMap contributors。ベクトルタイルは OpenFreeMap / © OpenMapTiles)から取得します。中心部は細かい建物まで、周辺は高い建物中心に絞ります。取得できない場合はOverpass API、OSMに建物がほとんど無い地域は、運行頻度から作る250mメッシュで代替します(PLATEAUは1タイルが約13MBと重いため対象外)。<br>
        ・都市の規模によっては数分かかります。処理中はこのページを閉じないでください。<br>
        ・鉄道の運行データには、公共交通オープンデータセンターが提供するデータ(JR東日本ほか。JR東日本分は公共交通オープンデータチャレンジ限定ライセンス)を利用しています。情報の正確性・完全性は保証されません。表示内容や操作に関するお問い合わせは、データ提供者ではなく、こちらの<a href="https://github.com/nicchizuofficial-debug/city-pulse-app/issues" target="_blank" rel="noopener">GitHub Issues</a>へお願いします。
      </div>
    </div>`;
  }

  async function renderSaved() {
    const box = $('#saved');
    let list = [];
    try { list = await CityStore.list(); } catch (e) { box.innerHTML = '<div class="empty">この端末では保存機能を使えません(プライベートブラウズ等)。作成後すぐに表示はできます。</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="empty">まだありません。下のフォームからGTFSをアップロードして作成できます。</div>'; return; }
    box.innerHTML = list.map((c) => `
      <div class="row" data-id="${esc(c.id)}">
        <div>
          <div class="city-name">${esc(c.name)}</div>
          <div class="city-sub">鉄道 ${c.railTrips.toLocaleString()}便${c.jrTrips ? `(うちJR東日本 ${c.jrTrips.toLocaleString()}便${c.jrPrefs && c.jrPrefs.length ? '・' + c.jrPrefs.map(esc).join('/') : ''})` : ''} ・ バス ${c.busTrips.toLocaleString()}便 ／ 運行日 ${esc(c.serviceDate)}<br>建物: ${esc(c.buildingDetail)}</div>
        </div>
        <div class="actions">
          <a class="btn primary" href="?city=${encodeURIComponent(c.id)}">開く</a>
          ${c.buildingSource === 'mesh' ? `<button class="btn" data-rebuild="${esc(c.id)}">OSMの建物で作り直す</button>` : ''}
          <button class="btn ghost" data-del="${esc(c.id)}">削除</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('この都市のデータを削除しますか?')) return;
      await CityStore.remove(b.dataset.del);
      renderSaved();
    }));
    box.querySelectorAll('[data-rebuild]').forEach((b) => b.addEventListener('click', () => rebuildBuildings(b.dataset.rebuild, b)));
  }

  // 保存済みの都市の建物だけを取り直す(GTFSの再アップロード不要)。メッシュ表示になっていた都市向け
  async function rebuildBuildings(id, btn) {
    if (busy) return;
    busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const meta = await CityStore.getMeta(id), data = await CityStore.getData(id);
      let bbox;
      if (meta.window) { const [w, s, e, n] = meta.window; bbox = { s, w, n, e }; }
      else {   // 古い保存データ: 表示範囲を少し広げて代用する
        const [w, s, e, n] = meta.viewBounds, pw = (e - w) * 0.2, ph = (n - s) * 0.2;
        bbox = { s: s - ph, w: w - pw, n: n + ph, e: e + pw };
      }
      let stopHeat = data.stopHeat;
      if (!stopHeat) {   // 古い保存データ: 各便の通過点から停留所ごとの通過数を再現する
        const cnt = new Map();
        for (const t of data.pulseData.trips) for (const p of t.path) { const k = p[0] + ',' + p[1]; const v = cnt.get(k); if (v) v[2]++; else cnt.set(k, [p[0], p[1], 1]); }
        stopHeat = [...cnt.values()];
      }
      const built = await BuildingLoader.load({ bbox, stopHeat, center: meta.center, extraPoints: data.jrPoints || [] },
        (fr, text) => { btn.textContent = (text || '取得中…').replace(/^建物データを/, '').slice(0, 28); });
      Object.assign(meta, { buildingSource: built.source, buildingDetail: built.detail, buildingCount: built.buildings.length, window: [bbox.w, bbox.s, bbox.e, bbox.n] });
      await CityStore.save(meta, { ...data, buildings: built.buildings, stopHeat });
    } catch (err) {
      console.error(err);
      alert('作り直しに失敗しました: ' + (err && err.message ? err.message : err));
    }
    busy = false;
    btn.textContent = label;
    renderSaved();
  }

  const MAX_FILES = 8;

  function renderFiles() {
    const box = $('#files');
    box.innerHTML = picked.map((p, i) => `
      <div class="frow" data-i="${i}">
        <div class="fname"><span class="file">${esc(p.file.name)}</span> <span class="fsize">${(p.file.size / 1048576).toFixed(1)} MB</span></div>
        <select class="fmode" data-i="${i}" aria-label="鉄道・バスの区分">
          <option value="auto"${p.mode === 'auto' ? ' selected' : ''}>区分: 自動判定</option>
          <option value="rail"${p.mode === 'rail' ? ' selected' : ''}>すべて鉄道として扱う</option>
          <option value="bus"${p.mode === 'bus' ? ' selected' : ''}>すべてバスとして扱う</option>
        </select>
        <button class="btn ghost small" data-rm="${i}" ${busy ? 'disabled' : ''}>外す</button>
      </div>`).join('');
    box.querySelectorAll('select.fmode').forEach((s) => s.addEventListener('change', () => { picked[+s.dataset.i].mode = s.value; }));
    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { picked.splice(+b.dataset.rm, 1); renderFiles(); }));
    $('#go').disabled = busy || picked.length === 0;
  }

  function addFiles(list) {
    let skipped = 0;
    for (const file of [...list]) {
      if (!/\.zip$/i.test(file.name)) { skipped++; continue; }
      if (picked.some((p) => p.file.name === file.name && p.file.size === file.size)) continue;
      if (picked.length >= MAX_FILES) { showError(`一度に読み込めるGTFSは${MAX_FILES}個までです。`); break; }
      picked.push({ file, mode: 'auto' });
    }
    if (skipped) showError('zip以外のファイルは無視しました(GTFSはzip形式です)。');
    else if (picked.length <= MAX_FILES) hideError();
    renderFiles();
  }

  // 1ファイルだけ選び直す(テスト・互換用)
  function setFile(file) { picked = []; if (file) addFiles([file]); else renderFiles(); }

  function showError(msg) { const e = $('#error'); e.textContent = msg; e.classList.add('on'); }
  function hideError() { $('#error').classList.remove('on'); }

  function makeProgress() {
    const bar = $('#barFill'), msg = $('#msg');
    const lis = [...document.querySelectorAll('#steps li')];
    let cur = 0;
    $('#progress').classList.add('on');
    return (key, frac, text) => {
      const i = STEPS.findIndex((s) => s.key === key);
      if (i < 0) return;
      cur = i;
      let base = 0;
      for (let k = 0; k < i; k++) base += STEPS[k].weight;
      bar.style.width = Math.min(100, (base + STEPS[i].weight * Math.max(0, Math.min(1, frac))) * 100).toFixed(1) + '%';
      if (text) msg.textContent = text;
      lis.forEach((li, k) => { li.className = k < cur ? 'done' : k === cur ? 'now' : ''; });
    };
  }

  function runWorker(files, onProgress, modes) {
    files = Array.isArray(files) ? files : [files];
    return new Promise((resolve, reject) => {
      const worker = new Worker('/static/gtfs-worker.js');
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') onProgress(m.stage, m.frac, m.msg);
        else if (m.type === 'done') { worker.terminate(); resolve(m.result); }
        else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
      };
      worker.onerror = (ev) => { worker.terminate(); reject(new Error(ev.message || 'Worker error')); };
      worker.postMessage({ files, modes: modes || files.map(() => 'auto') });
    });
  }

  // サーバーが持つJR東日本の運行(対象範囲内・加工済み)を取得する。使えない場合は null(作成は続ける)
  async function fetchJr(win, onProgress) {
    const [w, s, e, n] = win;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    try {
      onProgress('jr', 0.1, 'JR東日本の運行を取得中…(サーバーの準備に時間がかかることがあります)');
      const res = await fetch(`/api/jr-east?w=${w}&s=${s}&e=${e}&n=${n}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const j = await res.json();
      return j && j.available ? j : null;
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 追加の鉄道便を、運行データ・鼓動ヒストグラム・停留所ヒート(メッシュ・建物の元)へ足し込む。
  // カメラの表示範囲(viewBounds)と対象エリア(window)は、JR以外のGTFSだけで決めたまま変えない。
  function mergeRailTrips(result, extra) {
    const pd = result.pulseData, act = pd.activity, nB = act.length;
    for (const t of extra) {
      pd.trips.push(t);
      const b0 = Math.floor(t.timestamps[0] / pd.bucket_sec);
      if (b0 >= nB) continue;
      const b1 = Math.min(nB - 1, Math.floor(t.timestamps[t.timestamps.length - 1] / pd.bucket_sec));
      for (let b = Math.max(0, b0); b <= b1; b++) act[b].rail++;
    }
    let max = 1;
    for (const a of act) { a.count = a.rail + a.bus; if (a.count > max) max = a.count; }
    pd.max_activity = max;
    const heat = new Map(result.stopHeat.map((v) => [v[0] + ',' + v[1], v]));
    for (const t of extra) for (const p of t.path) {
      const k = p[0] + ',' + p[1], v = heat.get(k);
      if (v) v[2]++; else { const nv = [p[0], p[1], 1]; heat.set(k, nv); result.stopHeat.push(nv); }
    }
    result.meta.railTrips += extra.length;
  }

  async function create() {
    if (busy || !picked.length) return;
    busy = true; hideError();
    renderFiles();
    $('#files').querySelectorAll('select').forEach((s) => { s.disabled = true; });
    window.onbeforeunload = () => '作成中です。ページを閉じると最初からやり直しになります。';
    const progress = makeProgress();
    try {
      const result = await runWorker(picked.map((p) => p.file), progress, picked.map((p) => p.mode));
      let jrTrips = 0, jrPrefs = [];
      const jrPoints = [];   // JRが通る場所(建物・メッシュもここには必ず出す)
      if ($('#jrOpt').checked) {
        const jr = await fetchJr(result.meta.window, progress);
        if (jr && jr.trips.length) {
          mergeRailTrips(result, jr.trips);
          jrTrips = jr.trips.length;
          jrPrefs = (jr.prefectures || []).filter((p) => p.kept).map((p) => p.name);
          const seen = new Set();
          for (const t of jr.trips) for (const p of t.path) { const k = p[0] + ',' + p[1]; if (!seen.has(k)) { seen.add(k); jrPoints.push(p); } }
          result.meta.serviceDate = [...new Set([...String(result.meta.serviceDate).split(' / '), jr.service_date])].sort().join(' / ');
        }
        progress('jr', 1, jrTrips
          ? `JR東日本 ${jrTrips.toLocaleString()}便を重ねました${jrPrefs.length ? '(' + jrPrefs.join('・') + ')' : ''}`
          : 'このエリアにJR東日本の運行はありませんでした(または取得できませんでした)');
      }
      const [w, s, e, n] = result.meta.window;
      const built = await BuildingLoader.load({ bbox: { s, w, n, e }, stopHeat: result.stopHeat, center: result.meta.center, extraPoints: jrPoints },
        (fr, text) => progress('buildings', fr, text));

      progress('save', 0.2, '端末に保存中…');
      const base = picked[0].file.name.replace(/\.zip$/i, '');
      const name = $('#cityName').value.trim() || result.meta.agencyName || base;
      const id = 'c' + Date.now().toString(36);
      const meta = {
        id, name, createdAt: Date.now(),
        viewBounds: result.meta.viewBounds, center: result.meta.center, window: result.meta.window,
        railTrips: result.meta.railTrips, busTrips: result.meta.busTrips, serviceDate: result.meta.serviceDate,
        buildingSource: built.source, buildingDetail: built.detail, buildingCount: built.buildings.length,
        jrTrips, jrPrefs,
      };
      await CityStore.save(meta, { buildings: built.buildings, pulseData: result.pulseData, stopHeat: result.stopHeat, jrPoints });
      progress('save', 1, '完成!');
      window.onbeforeunload = null;
      location.href = '?city=' + encodeURIComponent(id);
    } catch (err) {
      window.onbeforeunload = null;
      console.error(err);
      showError('作成に失敗しました: ' + (err && err.message ? err.message : err));
      busy = false;
      renderFiles();
    }
  }

  function start() {
    const root = document.getElementById('home');
    root.innerHTML = html();
    renderSaved();

    const drop = $('#drop'), input = $('#file');
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
    $('#go').addEventListener('click', create);
    renderFiles();
  }

  return { start, create, setFile, addFiles, _runWorker: runWorker, _mergeRailTrips: mergeRailTrips };
})();
