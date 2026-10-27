/* app.js — interfaz, cola de procesamiento, guardado automático, exportación y respaldos. */
(() => {
  'use strict';
  const P = DniParser;
  const $ = (id) => document.getElementById(id);
  const HEADER = ['Nombre completo', 'DNI', 'Dirección', 'Estado'];

  const S = {
    photos: [], records: [], dups: new Map(),
    running: false, paused: false, ranInBatch: 0,
    filter: 'todos', sortAsc: true, query: '',
    status: '',
  };
  const urlCache = new Map();
  let wakeLock = null;

  /* ---------- utilidades ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function toast(msg, ms = 3500) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }
  function photoUrl(p) {
    const b = p.view || p.blob;
    if (!b) return null;
    if (!urlCache.has(p.id)) urlCache.set(p.id, URL.createObjectURL(b));
    return urlCache.get(p.id);
  }
  function dropUrl(id) { if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); } }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  /* ---------- guardado automático ---------- */
  const dirty = new Set();
  let saveTimer = null;
  function markDirty(rec) {
    dirty.add(rec.id);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    if (!dirty.size) return;
    const ids = [...dirty]; dirty.clear();
    const recs = ids.map((id) => S.records.find((r) => r.id === id)).filter(Boolean);
    try { await DB.putMany('records', recs); setSaved(); }
    catch (e) { ids.forEach((i) => dirty.add(i)); toast('⚠ No se pudo guardar: ' + e.message); }
  }
  function setSaved() { $('saved').textContent = '✓ Guardado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  addEventListener('pagehide', flushSave);
  addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- estadísticas ---------- */
  function stats() {
    const total = S.photos.length;
    const done = S.photos.filter((p) => p.status === 'done').length;
    const errors = S.photos.filter((p) => p.status === 'error').length;
    const empty = S.photos.filter((p) => p.status === 'done' && !p.nDetected).length;
    const review = S.records.filter((r) => P.estadoOf(r) === 'Revisar').length;
    const finished = done + errors;
    return { total, done, errors, empty, review, dni: S.records.length, pct: total ? Math.round((finished / total) * 100) : 0, pending: S.photos.filter((p) => p.status === 'pending' || p.status === 'processing').length };
  }
  function renderStats() {
    const s = stats();
    $('s-total').textContent = s.total; $('s-done').textContent = s.done; $('s-dni').textContent = s.dni;
    $('s-review').textContent = s.review; $('s-err').textContent = s.errors; $('s-pct').textContent = s.pct + '%';
    $('bar').style.width = s.pct + '%';
    $('tab-res-count').textContent = s.dni ? ' (' + s.dni + ')' : '';
    $('btn-retry').disabled = S.running || !(s.errors || s.empty);
    $('btn-retry').textContent = 'Reintentar errores' + (s.errors || s.empty ? ' (' + (s.errors + s.empty) + ')' : '');
    $('btn-start').textContent = S.running ? 'Procesando…' : (s.done || s.errors) && s.pending ? 'Continuar (' + s.pending + ')' : 'Procesar' + (s.pending ? ' (' + s.pending + ')' : '');
    $('btn-start').disabled = S.running || !s.pending;
    $('btn-pause').disabled = !S.running;
    $('status').textContent = S.status;
  }

  /* ---------- lista de fotos ---------- */
  const LABEL = { pending: 'En cola', processing: 'Leyendo…', done: 'Listo', error: 'Error' };
  function renderPhotos() {
    const box = $('photo-list');
    if (!S.photos.length) { box.innerHTML = '<p class="muted">Todavía no importaste fotos.</p>'; return; }
    const items = [...S.photos].reverse().slice(0, 300);
    box.innerHTML = items.map((p) => {
      const u = photoUrl(p);
      const cls = p.status === 'error' ? 'err' : p.status === 'done' && !p.nDetected ? 'warn' : p.status;
      const txt = p.status === 'done' ? (p.nDetected ? p.nDetected + ' DNI' : 'Sin DNI detectado') : p.status === 'error' ? 'Error: ' + (p.error || '') : LABEL[p.status];
      return '<div class="ph ' + cls + '">' + (u ? '<img loading="lazy" src="' + u + '" alt="">' : '<div class="noimg">—</div>') +
        '<div class="phi"><b>' + esc(p.name) + '</b><span>' + esc(txt) + (p.notes ? ' · ' + esc(p.notes) : '') + '</span></div></div>';
    }).join('') + (S.photos.length > 300 ? '<p class="muted">Mostrando las 300 más recientes de ' + S.photos.length + '.</p>' : '');
  }

  /* ---------- tabla de resultados ---------- */
  function visibleRecords() {
    const q = P.normName(S.query), qd = P.digits(S.query);
    let list = S.records.filter((r) => {
      if (S.filter === 'revisar' && P.estadoOf(r) !== 'Revisar') return false;
      if (S.filter === 'dup' && !S.dups.has(r.id)) return false;
      if (!S.query.trim()) return true;
      return (q && P.normName(r.nombre).includes(q)) || (qd && P.digits(r.dni).includes(qd));
    });
    list.sort((a, b) => {
      const A = P.normName(a.nombre) || '￿', B = P.normName(b.nombre) || '￿';
      return S.sortAsc ? A.localeCompare(B, 'es') : B.localeCompare(A, 'es');
    });
    return list;
  }
  function badge(r) {
    const e = P.estadoOf(r);
    const dup = S.dups.has(r.id) ? ' <span class="b dup" title="' + esc(S.dups.get(r.id)) + '">Posible duplicado</span>' : '';
    return '<span class="b ' + e.toLowerCase() + '">' + e + '</span>' + dup;
  }
  function cell(r, f, ph) {
    const flagged = r.flags[f];
    return '<input class="' + (flagged ? 'flag' : '') + '" data-id="' + r.id + '" data-f="' + f + '" value="' + esc(r[f]) + '" placeholder="' + (flagged ? 'Revisar' : ph) + '" autocomplete="off" ' + (f === 'dni' ? 'inputmode="numeric"' : '') + '>';
  }
  function renderTable() {
    S.dups = P.findDuplicates(S.records);
    const list = visibleRecords();
    $('count-line').textContent = list.length + ' de ' + S.records.length + ' registros';
    if (!S.records.length) { $('tbody').innerHTML = '<tr><td colspan="5" class="muted">Sin registros todavía. Importá y procesá fotos.</td></tr>'; return; }
    $('tbody').innerHTML = list.map((r) =>
      '<tr data-row="' + r.id + '"><td>' + cell(r, 'nombre', 'Nombre completo') + '</td><td>' + cell(r, 'dni', 'DNI') + '</td><td>' + cell(r, 'direccion', 'Dirección') +
      '</td><td class="st">' + badge(r) + '</td><td class="act"><button data-act="foto" title="Ver foto original">📷</button><button data-act="ok" title="Marcar como verificado">✓</button><button data-act="del" title="Eliminar registro">🗑</button></td></tr>'
    ).join('');
  }
  function refreshRow(r) {
    const tr = document.querySelector('tr[data-row="' + r.id + '"]');
    if (tr) {
      tr.querySelector('.st').innerHTML = badge(r);
      tr.querySelectorAll('input').forEach((i) => {
        const f = i.dataset.f; i.classList.toggle('flag', !!r.flags[f]); i.placeholder = r.flags[f] ? 'Revisar' : '';
      });
    }
    renderStats();
  }
  $('tbody').addEventListener('input', (e) => {
    const i = e.target; if (!i.dataset || !i.dataset.id) return;
    const r = S.records.find((x) => x.id === i.dataset.id); if (!r) return;
    const f = i.dataset.f;
    r[f] = f === 'dni' ? P.digits(i.value).slice(0, 9) : i.value;
    if (f === 'dni' && i.value !== r.dni) i.value = r.dni;
    r.flags[f] = !r[f] || (f === 'dni' && !P.validDni(r.dni));
    r.verificado = false;
    markDirty(r); refreshRow(r);
  });
  $('tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.closest('tr').dataset.row;
    const r = S.records.find((x) => x.id === id); if (!r) return;
    if (b.dataset.act === 'ok') { r.flags = { nombre: !r.nombre, dni: !P.validDni(r.dni), direccion: !r.direccion }; r.verificado = !(r.flags.nombre || r.flags.dni || r.flags.direccion) ; if (!r.verificado) toast('Completá los campos vacíos antes de verificar'); markDirty(r); refreshRow(r); renderTable(); }
    if (b.dataset.act === 'del') { if (!confirm('¿Eliminar este registro?')) return; S.records = S.records.filter((x) => x.id !== id); await DB.delete('records', id); renderTable(); renderStats(); }
    if (b.dataset.act === 'foto') showPhotos(r);
  });

  function showPhotos(r) {
    const ps = r.photoIds.map((id) => S.photos.find((p) => p.id === id)).filter(Boolean);
    const withImg = ps.filter((p) => photoUrl(p));
    if (!withImg.length) { toast('La foto ya no está guardada en este teléfono (borrada o no conservada).'); return; }
    $('viewer-body').innerHTML = '<p class="muted">' + esc(r.nombre || r.dni || 'Registro') + ' — ' + withImg.length + ' foto(s). Tocá la imagen para ampliar.</p>' +
      withImg.map((p) => '<figure><img src="' + photoUrl(p) + '" alt=""><figcaption>' + esc(p.name) + '</figcaption></figure>').join('');
    $('viewer').classList.add('open');
  }
  $('viewer-body').addEventListener('click', (e) => { if (e.target.tagName === 'IMG') e.target.classList.toggle('zoom'); });
  $('viewer-close').addEventListener('click', () => $('viewer').classList.remove('open'));

  /* ---------- filtros ---------- */
  $('q').addEventListener('input', (e) => { S.query = e.target.value; renderTable(); });
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
    renderTable();
  }));
  $('btn-sort').addEventListener('click', () => { S.sortAsc = !S.sortAsc; $('btn-sort').textContent = 'Nombre ' + (S.sortAsc ? 'A→Z' : 'Z→A'); renderTable(); });

  /* ---------- pestañas ---------- */
  function tab(name) {
    $('pane-import').hidden = name !== 'import'; $('pane-res').hidden = name !== 'res';
    $('tab-import').classList.toggle('on', name === 'import'); $('tab-res').classList.toggle('on', name === 'res');
    if (name === 'res') renderTable();
  }
  $('tab-import').addEventListener('click', () => tab('import'));
  $('tab-res').addEventListener('click', () => tab('res'));

  /* ---------- importación ---------- */
  async function importFiles(files) {
    const imgs = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!imgs.length) { toast('No se encontraron imágenes.'); return; }
    const known = new Set(S.photos.map((p) => p.key));
    let added = 0, skipped = 0;
    for (let i = 0; i < imgs.length; i += 25) {
      const chunk = [];
      for (const f of imgs.slice(i, i + 25)) {
        const key = f.name + '|' + f.size + '|' + f.lastModified;
        if (known.has(key)) { skipped++; continue; }
        known.add(key);
        chunk.push({ id: uid(), key, name: f.name, size: f.size, addedAt: Date.now(), status: 'pending', blob: f, view: null, nDetected: 0, notes: '', error: '' });
      }
      if (chunk.length) { await DB.putMany('photos', chunk); S.photos.push(...chunk); added += chunk.length; }
      S.status = 'Importando… ' + Math.min(i + 25, imgs.length) + '/' + imgs.length; renderStats();
    }
    S.status = '';
    toast(added + ' foto(s) importadas' + (skipped ? ' · ' + skipped + ' ya estaban' : ''));
    setSaved(); renderStats(); renderPhotos();
  }
  $('file').addEventListener('change', async (e) => { await importFiles(e.target.files); e.target.value = ''; });
  $('btn-pick').addEventListener('click', () => $('file').click());

  /* ---------- cola de procesamiento ---------- */
  async function setWake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) { /* opcional */ }
  }
  async function processOne(p) {
    p.status = 'processing'; p.error = ''; p.notes = '';
    S.status = 'Leyendo ' + p.name + '…'; renderStats(); renderPhotos();
    await DB.put('photos', p);
    let touched = [];
    try {
      const res = await Engine.processPhoto(p.blob, p.id, {
        ocrAlways: $('opt-fronts').checked,
        onStatus: (m) => { S.status = m; $('status').textContent = m; },
      });
      const { added, merged } = P.addWithDedupe(S.records, res.records);
      touched = [...added, ...merged];
      p.nDetected = res.records.length;
      p.notes = res.notes.join(' · ');
      p.view = await Engine.makeView(res.canvas);
      p.status = 'done';
      // si no se detectó nada, conservamos el original para poder reintentar
      if (p.nDetected && !$('opt-keep-orig').checked) p.blob = null;
    } catch (e) {
      p.status = 'error'; p.error = String(e && e.message || e).slice(0, 120);
    }
    dropUrl(p.id);
    await DB.commit(p, touched); // foto + registros en una sola transacción
    setSaved();
  }
  async function runQueue() {
    if (S.running) return;
    S.running = true; S.paused = false; S.ranInBatch = 0;
    const batch = parseInt($('batch').value, 10) || 0;
    await setWake(true);
    try {
      for (;;) {
        if (S.paused) break;
        if (batch && S.ranInBatch >= batch) { toast('Tanda de ' + batch + ' completada. Tocá "Continuar" para seguir.'); break; }
        const next = S.photos.find((p) => p.status === 'pending');
        if (!next) break;
        await processOne(next);
        S.ranInBatch++;
        renderStats(); renderPhotos();
        if (S.ranInBatch % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      S.running = false; S.status = ''; await setWake(false);
      renderStats(); renderPhotos(); renderTable();
      const s = stats();
      if (!s.pending && s.total) toast('Listo: ' + s.dni + ' DNI · ' + s.review + ' por revisar · ' + s.errors + ' errores', 6000);
    }
  }
  $('btn-start').addEventListener('click', runQueue);
  $('btn-pause').addEventListener('click', () => { S.paused = true; S.status = 'Pausando al terminar la foto actual…'; renderStats(); });
  $('btn-retry').addEventListener('click', async () => {
    const redo = S.photos.filter((p) => (p.status === 'error' || (p.status === 'done' && !p.nDetected)) && p.blob);
    const lost = S.photos.filter((p) => (p.status === 'error') && !p.blob).length;
    redo.forEach((p) => { p.status = 'pending'; p.error = ''; });
    await DB.putMany('photos', redo);
    if (lost) toast(lost + ' error(es) sin la foto original: volvé a importarlas.');
    renderStats(); renderPhotos();
    if (redo.length) runQueue();
  });

  /* ---------- exportación ---------- */
  function exportRows() {
    const list = [...S.records].sort((a, b) => (P.normName(a.nombre) || '￿').localeCompare(P.normName(b.nombre) || '￿', 'es'));
    return P.exportRows(list, P.findDuplicates(S.records));
  }
  $('btn-xlsx').addEventListener('click', async () => {
    await flushSave();
    if (!S.records.length) return toast('No hay registros para exportar.');
    const bytes = XlsxMin.build(HEADER, exportRows(), 'Jugadores', [34, 14, 52, 26]);
    download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'jugadores_dni_' + today() + '.xlsx');
  });
  $('btn-csv').addEventListener('click', async () => {
    await flushSave();
    if (!S.records.length) return toast('No hay registros para exportar.');
    download(new Blob([P.toCsv(HEADER, exportRows())], { type: 'text/csv;charset=utf-8' }), 'jugadores_dni_' + today() + '.csv');
  });

  /* ---------- respaldo ---------- */
  function blobToDataUrl(b) { return new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); }); }
  async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }
  $('btn-backup').addEventListener('click', async () => {
    await flushSave();
    const withPhotos = $('opt-backup-photos').checked;
    const photos = [];
    for (const p of S.photos) {
      const m = { id: p.id, key: p.key, name: p.name, size: p.size, addedAt: p.addedAt, status: p.status === 'processing' ? 'pending' : p.status, nDetected: p.nDetected, notes: p.notes, error: p.error };
      if (withPhotos && (p.view || p.blob)) m.viewData = await blobToDataUrl(p.view || p.blob);
      photos.push(m);
    }
    const json = JSON.stringify({ app: 'dni-extractor', version: 1, exportedAt: new Date().toISOString(), records: S.records, photos });
    download(new Blob([json], { type: 'application/json' }), 'respaldo_dni_' + today() + '.json');
    toast('Respaldo descargado. Contiene datos personales: guardalo en un lugar privado.', 6000);
  });
  $('btn-restore').addEventListener('click', () => $('file-restore').click());
  $('file-restore').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'dni-extractor' || !Array.isArray(d.records)) throw new Error('No es un respaldo de esta app');
      const haveR = new Set(S.records.map((r) => r.id)), haveP = new Set(S.photos.map((p) => p.id));
      let nr = 0, np = 0;
      const newPhotos = [];
      for (const m of d.photos || []) {
        if (haveP.has(m.id)) continue;
        const p = { id: m.id, key: m.key, name: m.name, size: m.size, addedAt: m.addedAt, status: m.status === 'done' ? 'done' : 'error', nDetected: m.nDetected || 0, notes: m.notes || '', error: m.status === 'done' ? '' : 'Foto no incluida en el respaldo', blob: null, view: m.viewData ? await dataUrlToBlob(m.viewData) : null };
        newPhotos.push(p); np++;
      }
      const newRecs = [];
      for (const r of d.records) { if (!haveR.has(r.id)) { newRecs.push(r); nr++; } }
      await DB.putMany('photos', newPhotos); await DB.putMany('records', newRecs);
      S.photos.push(...newPhotos); S.records.push(...newRecs);
      renderStats(); renderPhotos(); renderTable();
      toast('Respaldo importado: ' + nr + ' registros nuevos, ' + np + ' fotos.');
    } catch (err) { toast('No se pudo importar: ' + err.message, 6000); }
  });

  /* ---------- eliminación ---------- */
  $('btn-del-photos').addEventListener('click', async () => {
    if (!confirm('Se borran las fotos guardadas en este teléfono (los datos extraídos se conservan). ¿Continuar?')) return;
    for (const p of S.photos) { p.blob = null; p.view = null; dropUrl(p.id); if (p.status === 'pending') p.status = 'error', p.error = 'Foto borrada'; }
    await DB.putMany('photos', S.photos);
    renderStats(); renderPhotos(); toast('Fotos borradas.');
  });
  $('btn-del-all').addEventListener('click', async () => {
    if (S.running) return toast('Pausá el procesamiento primero.');
    if (!confirm('Se eliminan TODAS las fotos y TODOS los registros de este teléfono. Esto no se puede deshacer. ¿Seguro?')) return;
    if (!confirm('Última confirmación: ¿ya exportaste o hiciste el respaldo?')) return;
    for (const id of [...urlCache.keys()]) dropUrl(id);
    await DB.clear(['photos', 'records', 'inbox']);
    S.photos = []; S.records = []; renderStats(); renderPhotos(); renderTable(); toast('Todo eliminado.');
  });

  /* ---------- arranque y recuperación ---------- */
  async function init() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
    S.photos = (await DB.getAll('photos')).sort((a, b) => a.addedAt - b.addedAt);
    S.records = await DB.getAll('records');
    // trabajos interrumpidos: lo que quedó "leyendo" vuelve a la cola
    const interrupted = S.photos.filter((p) => p.status === 'processing');
    interrupted.forEach((p) => { p.status = p.blob ? 'pending' : 'error'; if (!p.blob) p.error = 'Interrumpida'; });
    if (interrupted.length) await DB.putMany('photos', interrupted);
    // fotos recibidas con "Compartir" desde Google Fotos u otra app
    try {
      const inbox = await DB.takeInbox();
      if (inbox.length) { await importFiles(inbox); tab('import'); }
    } catch (_) {}
    renderStats(); renderPhotos(); renderTable();
    const s = stats();
    if (s.pending && !inbox_shared()) {
      $('resume').hidden = false;
      $('resume-text').textContent = 'Hay ' + s.pending + ' foto(s) sin procesar de la sesión anterior' + (interrupted.length ? ' (' + interrupted.length + ' interrumpida/s)' : '') + '.';
    }
    if (S.records.length || S.photos.length) setSaved();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  const inbox_shared = () => /[?&]shared=1/.test(location.search);
  $('btn-resume').addEventListener('click', () => { $('resume').hidden = true; runQueue(); });
  $('btn-resume-no').addEventListener('click', () => { $('resume').hidden = true; });
  init();
})();
