/* 作成した都市データをこの端末のブラウザ内(IndexedDB)に保存する。サーバーには送信しない。 */
'use strict';

const CityStore = (() => {
  const DB_NAME = 'citypulse';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('data');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(stores, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    async save(meta, data) {
      await tx(['meta', 'data'], 'readwrite', (t) => {
        t.objectStore('meta').put(meta);
        t.objectStore('data').put(data, meta.id);
      });
    },
    async list() {
      let all = [];
      await tx(['meta'], 'readonly', async (t) => { all = await req2p(t.objectStore('meta').getAll()); });
      return all.sort((a, b) => b.createdAt - a.createdAt);
    },
    async getMeta(id) {
      let m;
      await tx(['meta'], 'readonly', async (t) => { m = await req2p(t.objectStore('meta').get(id)); });
      return m;
    },
    async getData(id) {
      let d;
      await tx(['data'], 'readonly', async (t) => { d = await req2p(t.objectStore('data').get(id)); });
      return d;
    },
    async remove(id) {
      await tx(['meta', 'data'], 'readwrite', (t) => {
        t.objectStore('meta').delete(id);
        t.objectStore('data').delete(id);
      });
    },
  };
})();
