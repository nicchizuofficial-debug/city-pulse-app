/* サウンド(Web Audioで合成。音声ファイルは使わない)
 *  ・心拍: 画面の脈と同じ拍で「ドクン・ドクッ」。運行が多いほど大きく、閑散時はほとんど聞こえない程度に
 *  ・環境音: 時間帯ごとの和音がゆっくり移ろう。どの時間帯も明るい響き(長調)・柔らかい音色にして、
 *    深夜でも「静かで穏やかな街」に聞こえるようにする(低い短調のドローンは不気味に聞こえるため使わない)
 *  ・運行の粒: 画面内で駅・停留所に着いた便を1音ずつ(鉄道=チェレスタ風、バス=マリンバ風)。数は運行量に比例
 * ブラウザの自動再生制限のため、利用者の操作(ボタン)で開始する。既定はOFF。
 */
'use strict';

const CitySound = (() => {
  const PREF_KEY = 'cityPulseSound';
  let ctx = null, master = null, reverbIn = null, padFilter = null, padGain = null;
  let voices = [];
  let enabled = false;
  let unlockEl = null;   // iOS のマナーモードでも鳴らすための無音ループ(<audio>)
  let lastChordKey = '', lastUpdateAt = 0;

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // 時間帯ごとの和音(MIDIノート)。画面の時間帯ラベルと同じ区切り
  const CHORDS = [
    { until: 4.5,  key: 'night',   notes: [53, 57, 64, 67] },   // Fmaj9 深夜(穏やか)
    { until: 6,    key: 'dawn',    notes: [48, 55, 62, 64] },   // Cadd9 夜明け
    { until: 9.5,  key: 'morning', notes: [55, 59, 62, 69] },   // Gadd9 朝ラッシュ
    { until: 16,   key: 'day',     notes: [48, 55, 59, 64] },   // Cmaj7 日中
    { until: 19.5, key: 'evening', notes: [53, 57, 60, 64] },   // Fmaj7 夕ラッシュ
    { until: 22.5, key: 'dusk',    notes: [48, 55, 62, 67] },   // Cadd9 夜
    { until: 24,   key: 'night2',  notes: [53, 57, 64, 67] },   // Fmaj9 深夜
  ];
  const chordAt = (hour) => CHORDS.find((c) => hour < c.until) || CHORDS[CHORDS.length - 1];

  function readPref() { try { return localStorage.getItem(PREF_KEY) === '1'; } catch (e) { return false; } }
  function writePref(on) { try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) { /* 保存できなくても動作は続ける */ } }

  function makeReverb() {
    const len = Math.floor(ctx.sampleRate * 2.8);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    return conv;
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(comp).connect(ctx.destination);
    const rev = makeReverb();
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.9;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.35;
    reverbIn.connect(rev).connect(revOut).connect(master);

    // 環境音(4声 × わずかにずらした2本の鋸歯状波 → ローパス)
    padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass'; padFilter.frequency.value = 1400; padFilter.Q.value = 0.5;
    padGain = ctx.createGain();
    padGain.gain.value = 0;
    padFilter.connect(padGain);
    padGain.connect(master);
    padGain.connect(reverbIn);
    // フィルタをゆっくり揺らす(呼吸感)
    const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.06; lfoAmt.gain.value = 250;
    lfo.connect(lfoAmt).connect(padFilter.frequency);
    lfo.start();
    voices = [0, 1, 2, 3].map(() => {
      const g = ctx.createGain();
      g.gain.value = 0.2;
      // わずかにずらした三角波2本 + 1オクターブ上の小さな正弦波(柔らかく、にごらない音色)
      const oscs = [['triangle', -6, 1, 1], ['triangle', 6, 1, 1], ['sine', 0, 2, 0.25]].map(([type, cents, mul, lv]) => {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        og.gain.value = lv;
        o.type = type;
        o.detune.value = cents;
        o.frequency.value = 220 * mul;
        o.mul = mul;
        o.connect(og).connect(g);
        o.start();
        return o;
      });
      g.connect(padFilter);
      return { g, oscs };
    });
  }

  function setChord(chord, immediate) {
    const now = ctx.currentTime;
    chord.notes.forEach((n, i) => {
      voices[i].oscs.forEach((o) => {
        if (immediate) o.frequency.setValueAtTime(midi(n) * o.mul, now);
        else o.frequency.setTargetAtTime(midi(n) * o.mul, now, 1.2);
      });
    });
  }

  // 時刻・運行比率に合わせて環境音を更新(毎フレーム呼ばれてよい。内部で間引く)
  function update(hour, ratio) {
    if (!enabled || !ctx) return;
    const nowMs = performance.now();
    if (nowMs - lastUpdateAt < 200) return;
    lastUpdateAt = nowMs;
    const chord = chordAt(((hour % 24) + 24) % 24);
    if (chord.key !== lastChordKey) { setChord(chord, !lastChordKey); lastChordKey = chord.key; }
    const now = ctx.currentTime;
    padFilter.frequency.setTargetAtTime(1400 + 1600 * ratio, now, 0.8);
    padGain.gain.setTargetAtTime(0.22 + 0.1 * ratio, now, 0.8);
  }

  // 1回の「ドクン」(低い正弦波 + 聞き取りやすい倍音 + ごく短い打撃音)
  function thump(t, f0, amp) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.015, 0.09);
    g.connect(master);
    const send = ctx.createGain(); send.gain.value = 0.25; g.connect(send).connect(reverbIn);
    [[1, 1], [2, 0.35]].forEach(([mul, lv]) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain(); og.gain.value = lv;
      o.type = 'sine';
      o.frequency.setValueAtTime((f0 + 45) * mul, t);
      o.frequency.setTargetAtTime(f0 * mul, t, 0.025);
      o.connect(og).connect(g);
      o.start(t); o.stop(t + 0.6);
    });
  }

  // 心拍1拍ぶんを予約する。period: 1拍の長さ(秒)、phase: いまの拍内位置(0〜1)。
  // 画面の「ドクン」(拍の5%)・「ドクッ」(24%)と同じ位置で鳴らす
  function beat(period, ratio, phase = 0) {
    if (!enabled || !ctx) return;
    const t = ctx.currentTime + 0.01;
    const amp = 0.05 + 0.38 * Math.pow(ratio, 1.5);   // 閑散時はごく小さく(静寂の中の心拍は不気味に聞こえるため)
    thump(t + Math.max(0, 0.05 - phase) * period, 58, amp);
    thump(t + Math.max(0, 0.24 - phase) * period, 52, amp * 0.65);
  }


  // ---- 運行の粒: 駅・停留所に着いた便を1音ずつ鳴らす ----
  // 1秒あたりに鳴らせる数(運行比率に比例。深夜 約0.5個/秒 → ラッシュ 約7個/秒)。溜めすぎない
  let bucket = 0, lastAllowAt = 0;
  function allow(ratio) {
    if (!enabled || !ctx || ctx.state !== 'running') { lastAllowAt = 0; return 0; }
    const now = performance.now();
    const dt = lastAllowAt ? Math.min(0.5, (now - lastAllowAt) / 1000) : 0;
    lastAllowAt = now;
    bucket = Math.min(2.5, bucket + dt * (0.5 + 6.5 * ratio));
    const n = Math.floor(bucket);
    bucket -= n;
    return n;
  }

  // Cメジャー・ペンタトニック(どの時間帯の和音とも濁らない)。画面の上ほど高い音
  const PENTA = [0, 2, 4, 7, 9];
  // 倍音は整数倍だけ(非整数倍は「おりん」のような響きになるため使わない)
  const TIMBRE = {
    rail: { base: 72, partials: [[1, 1], [2, 0.16], [3, 0.05]], decay: 0.55, level: 0.075 },   // チェレスタ風
    bus:  { base: 60, partials: [[1, 1], [4, 0.1]], decay: 0.22, level: 0.085 },                // マリンバ風
  };
  function note(mode, x, y) {
    if (!enabled || !ctx) return;
    const tb = TIMBRE[mode === 'rail' ? 'rail' : 'bus'];
    const deg = Math.max(0, Math.min(9, Math.floor((1 - y) * 10)));
    const f = midi(tb.base + PENTA[deg % 5] + 12 * Math.floor(deg / 5));
    const t = ctx.currentTime + 0.01 + Math.random() * 0.05;   // 機械的に揃わないよう少し揺らす
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(tb.level, t + 0.005);
    g.gain.setTargetAtTime(0, t + 0.01, tb.decay / 3);
    const out = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (out.pan) out.pan.value = Math.max(-0.85, Math.min(0.85, x * 2 - 1));
    g.connect(out);
    out.connect(master);
    const send = ctx.createGain(); send.gain.value = 0.55; out.connect(send).connect(reverbIn);
    tb.partials.forEach(([mul, lv]) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * mul;
      og.gain.value = lv;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + tb.decay * 2.5);
    });
  }

  // iOS Safari はマナーモード中 Web Audio を消音する。無音の <audio> を同時に再生すると
  // 音声の扱いが「メディア再生」に切り替わり、マナーモードでも鳴るようになる
  function silentWavUrl() {
    const n = 4410, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }

  function setEnabled(on) {
    enabled = on;
    writePref(on);
    if (on) {
      // ここは必ずクリック等の操作の中で同期的に実行する(ブラウザの自動再生制限)
      if (!ctx) build();
      if (!unlockEl) { unlockEl = new Audio(silentWavUrl()); unlockEl.loop = true; unlockEl.setAttribute('playsinline', ''); }
      unlockEl.play().catch(() => {});
      const start = () => { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.12); };
      if (ctx.state !== 'running') ctx.resume().then(start, start); else start();
      lastUpdateAt = 0;
    } else if (ctx) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
      if (unlockEl) unlockEl.pause();
      setTimeout(() => { if (!enabled && ctx) ctx.suspend(); }, 600);
    }
    onChange(on);
  }

  let onChange = () => {};
  // ボタンを結び付ける。前回ONにしていた場合は、最初の操作(クリック・タップ・キー)で自動的に再開する
  function attach(button) {
    const render = (on) => {
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.classList.toggle('on', on);
      button.querySelector('.lbl').textContent = on ? 'サウンド ON' : 'サウンド';
      button.title = on ? '音を止める' : '音を出す(心拍と環境音)';
    };
    onChange = render;
    render(false);
    button.addEventListener('click', (e) => { e.stopPropagation(); setEnabled(!enabled); });
    if (readPref()) {
      button.classList.add('wants');
      // タッチでは「押した瞬間」は音の許可にならないため、離した瞬間(pointerup/touchend)・キー操作で再開する
      const EVENTS = ['pointerup', 'touchend', 'keydown'];
      const resume = (e) => {
        EVENTS.forEach((ev) => window.removeEventListener(ev, resume, true));
        button.classList.remove('wants');
        if (e && button.contains(e.target)) return;   // ボタン自体の操作は click 側で切り替える
        if (!enabled) setEnabled(true);
      };
      EVENTS.forEach((ev) => window.addEventListener(ev, resume, true));
    }
    document.addEventListener('visibilitychange', () => {
      if (!ctx || !enabled) return;
      if (document.hidden) ctx.suspend(); else ctx.resume();
    });
  }

  return { attach, update, beat, allow, note, isOn: () => enabled };
})();
