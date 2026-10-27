/* sw.js — (1) recibe fotos de "Compartir" de Android, (2) deja la app y las librerías en caché para uso sin conexión.
   Las fotos recibidas se guardan solo en la base privada del navegador (IndexedDB), nunca se envían a ningún lado. */
const CACHE = 'dni-app-v1';
const SHELL = ['./', './index.html', './app.js', './parser.js', './xlsxmin.js', './db.js', './engine.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith('dni-app-')).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('dni-extractor', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      ['photos', 'records'].forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('photos').filter((f) => f && f.size);
    const db = await openDb();
    await new Promise((res, rej) => {
      const t = db.transaction('inbox', 'readwrite');
      files.forEach((f) => t.objectStore('inbox').add(f));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch (_) { /* si falla, la app abre igual */ }
  return Response.redirect('./index.html?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  const lib = /(^|\.)cdn\.jsdelivr\.net$/.test(url.hostname);
  if (!sameOrigin && !lib) return; // nada más sale de acá
  e.respondWith(
    caches.match(e.request, { ignoreSearch: sameOrigin }).then((hit) => {
      if (hit) {
        if (sameOrigin) fetch(e.request).then((r) => r.ok && caches.open(CACHE).then((c) => c.put(e.request, r))).catch(() => {});
        return hit;
      }
      return fetch(e.request).then((r) => {
        if (r.ok && (lib || sameOrigin)) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
