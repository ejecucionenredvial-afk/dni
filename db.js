/* db.js — almacenamiento privado en IndexedDB del propio teléfono (no se sube a ningún servidor). */
const DB = (() => {
  const NAME = 'dni-extractor';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(NAME, VERSION);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { autoIncrement: true });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }

  function tx(stores, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(stores, mode);
          let result;
          Promise.resolve(fn(t)).then((r) => { result = r; }).catch((e) => { try { t.abort(); } catch (_) {} reject(e); });
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('transacción abortada'));
        })
    );
  }
  const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    open,
    getAll: (store) => tx([store], 'readonly', (t) => rq(t.objectStore(store).getAll())),
    get: (store, key) => tx([store], 'readonly', (t) => rq(t.objectStore(store).get(key))),
    put: (store, value, key) => tx([store], 'readwrite', (t) => rq(t.objectStore(store).put(value, key))),
    putMany: (store, values) =>
      tx([store], 'readwrite', (t) => { const s = t.objectStore(store); values.forEach((v) => s.put(v)); }),
    delete: (store, key) => tx([store], 'readwrite', (t) => rq(t.objectStore(store).delete(key))),
    clear: (stores) => tx(stores, 'readwrite', (t) => { stores.forEach((s) => t.objectStore(s).clear()); }),
    /** Guarda de forma atómica el resultado de una foto: foto + registros nuevos/actualizados. */
    commit: (photo, records) =>
      tx(['photos', 'records'], 'readwrite', (t) => {
        t.objectStore('photos').put(photo);
        records.forEach((r) => t.objectStore('records').put(r));
      }),
    /** Vacía y devuelve las fotos recibidas desde "Compartir" de Android. */
    takeInbox: () =>
      tx(['inbox'], 'readwrite', async (t) => {
        const s = t.objectStore('inbox');
        const all = await rq(s.getAll());
        s.clear();
        return all;
      }),
  };
})();
