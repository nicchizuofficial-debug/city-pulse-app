/* 依存なしの最小限のMapbox Vector Tile(MVT)デコーダ。建物ポリゴンの取り出し専用。
 *  decodeLayer(bytes, layerName) → { extent, features: [{ props, rings:[[[x,y],...],...] }] }  (ringsはタイル内座標) */
'use strict';

(function (root) {
  function reader(buf) {
    let pos = 0;
    const end = buf.length;
    return {
      get pos() { return pos; },
      set pos(v) { pos = v; },
      eof: () => pos >= end,
      varint() {
        let r = 0, shift = 0, b;
        do {
          b = buf[pos++];
          r += (b & 0x7f) * Math.pow(2, shift);   // 32bit超の値にも対応
          shift += 7;
        } while (b & 0x80);
        return r;
      },
      bytes() { const len = this.varint(); const s = pos; pos += len; return [s, pos]; },
      skip(wire) {
        if (wire === 0) this.varint();
        else if (wire === 1) pos += 8;
        else if (wire === 2) pos += this.varint();
        else if (wire === 5) pos += 4;
        else throw new Error('bad wire type ' + wire);
      },
    };
  }

  const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

  function readValue(buf, s, e) {
    const r = reader(buf.subarray(s, e));
    let v = null;
    while (!r.eof()) {
      const tag = r.varint(), field = tag >> 3, wire = tag & 7;
      if (field === 1 && wire === 2) { const [a, b] = r.bytes(); v = new TextDecoder().decode(buf.subarray(s + a, s + b)); }
      else if (field === 2 && wire === 5) { const p = r.pos; v = new DataView(buf.buffer, buf.byteOffset + s + p, 4).getFloat32(0, true); r.pos = p + 4; }
      else if (field === 3 && wire === 1) { const p = r.pos; v = new DataView(buf.buffer, buf.byteOffset + s + p, 8).getFloat64(0, true); r.pos = p + 8; }
      else if ((field === 4 || field === 5) && wire === 0) v = r.varint();
      else if (field === 6 && wire === 0) v = zigzag(r.varint());
      else if (field === 7 && wire === 0) v = !!r.varint();
      else r.skip(wire);
    }
    return v;
  }

  function decodeGeometry(geom) {
    const rings = [];
    let cur = null, x = 0, y = 0, i = 0;
    while (i < geom.length) {
      const cmd = geom[i] & 7, count = geom[i] >> 3;
      i++;
      if (cmd === 1 || cmd === 2) {
        for (let k = 0; k < count; k++) {
          x += zigzag(geom[i++]); y += zigzag(geom[i++]);
          if (cmd === 1) { cur = []; rings.push(cur); }
          cur.push([x, y]);
        }
      } else if (cmd === 7 && cur && cur.length) {
        cur.push([cur[0][0], cur[0][1]]);
      }
    }
    return rings;
  }

  function decodeLayer(buf, layerName) {
    const t = reader(buf);
    while (!t.eof()) {
      const tag = t.varint(), field = tag >> 3, wire = tag & 7;
      if (field !== 3 || wire !== 2) { t.skip(wire); continue; }
      const [ls, le] = t.bytes();
      const L = reader(buf.subarray(ls, le));
      const lb = buf.subarray(ls, le);
      let name = '', extent = 4096;
      const keys = [], values = [], featRanges = [];
      while (!L.eof()) {
        const tg = L.varint(), f = tg >> 3, w = tg & 7;
        if (f === 1 && w === 2) { const [a, b] = L.bytes(); name = new TextDecoder().decode(lb.subarray(a, b)); }
        else if (f === 2 && w === 2) featRanges.push(L.bytes());
        else if (f === 3 && w === 2) { const [a, b] = L.bytes(); keys.push(new TextDecoder().decode(lb.subarray(a, b))); }
        else if (f === 4 && w === 2) { const [a, b] = L.bytes(); values.push(readValue(lb, a, b)); }
        else if (f === 5 && w === 0) extent = L.varint();
        else L.skip(w);
      }
      if (name !== layerName) continue;

      const features = [];
      for (const [fs, fe] of featRanges) {
        const F = reader(lb.subarray(fs, fe));
        const fb = lb.subarray(fs, fe);
        let type = 0, tags = null, geom = null;
        while (!F.eof()) {
          const tg = F.varint(), f = tg >> 3, w = tg & 7;
          if (f === 3 && w === 0) type = F.varint();
          else if (f === 2 && w === 2) {
            const [a, b] = F.bytes(); const R = reader(fb.subarray(a, b)); tags = [];
            while (!R.eof()) tags.push(R.varint());
          } else if (f === 4 && w === 2) {
            const [a, b] = F.bytes(); const R = reader(fb.subarray(a, b)); geom = [];
            while (!R.eof()) geom.push(R.varint());
          } else F.skip(w);
        }
        if (type !== 3 || !geom) continue;   // ポリゴンのみ
        const props = {};
        if (tags) for (let k = 0; k + 1 < tags.length; k += 2) props[keys[tags[k]]] = values[tags[k + 1]];
        features.push({ props, rings: decodeGeometry(geom) });
      }
      return { extent, features };
    }
    return { extent: 4096, features: [] };
  }

  const api = { decodeLayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MVT = api;
})(typeof self !== 'undefined' ? self : this);
