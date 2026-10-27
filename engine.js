/* engine.js — lectura de DNI 100% en el teléfono.
   1) Código PDF417 del dorso (exacto: nombre y DNI) → BarcodeDetector de Android/Chrome, con zxing-wasm de respaldo.
   2) OCR con Tesseract.js (español) para el domicilio impreso en el dorso, y para frentes sin código.
   Las fotos NUNCA se envían a ningún servidor. Solo se descargan (una vez) el código de las librerías
   y el idioma español desde cdn.jsdelivr.net; el service worker los guarda para uso sin conexión. */
const Engine = (() => {
  const P = DniParser;
  const CDN = {
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    zxing: 'https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js',
  };
  const MAX_SIDE = 3000;
  const OCR_CONF_OK = 75; // por debajo de esto el campo queda en "Revisar"

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar ' + src));
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  /* ---------- imagen ---------- */
  async function decodeToCanvas(blob) {
    let bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (_) { bmp = await createImageBitmap(blob); }
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  /** Copia en gris con contraste estirado (no toca el original). */
  function enhance(src, { sharpen = false } = {}) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = d[i + 1] = d[i + 2] = g; hist[g]++;
    }
    const total = c.width * c.height;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }
    const span = Math.max(40, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    if (sharpen) { // máscara de enfoque simple
      const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
      const octx = o.getContext('2d');
      octx.filter = 'blur(1.2px)'; octx.drawImage(c, 0, 0); octx.filter = 'none';
      const bl = octx.getImageData(0, 0, c.width, c.height).data;
      const cur = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < cur.data.length; i += 4) {
        const v = Math.max(0, Math.min(255, cur.data[i] + 1.4 * (cur.data[i] - bl[i])));
        cur.data[i] = cur.data[i + 1] = cur.data[i + 2] = v;
      }
      ctx.putImageData(cur, 0, 0);
    }
    return c;
  }

  function rotate(src, deg) {
    const c = document.createElement('canvas');
    const swap = deg === 90 || deg === 270;
    c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  /* ---------- códigos PDF417 ---------- */
  let nativeDetector; // undefined = sin probar, null = no disponible
  async function getNative() {
    if (nativeDetector !== undefined) return nativeDetector;
    nativeDetector = null;
    try {
      if ('BarcodeDetector' in self) {
        const fm = await BarcodeDetector.getSupportedFormats();
        if (fm.includes('pdf417')) nativeDetector = new BarcodeDetector({ formats: ['pdf417'] });
      }
    } catch (_) { nativeDetector = null; }
    return nativeDetector;
  }

  async function zxingRead(canvas) {
    await loadScript(CDN.zxing);
    const Z = self.ZXingWASM || {};
    const read = Z.readBarcodes || (Z.reader && Z.reader.readBarcodes) || (Z.Reader && Z.Reader.readBarcodes);
    if (!read) throw new Error('zxing-wasm no disponible');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const res = await read(img, { formats: ['PDF417'], tryHarder: true, tryRotate: true, maxNumberOfSymbols: 12 });
    return res.filter((r) => r.isValid !== false && r.text).map((r) => ({
      raw: r.text,
      corners: r.position ? [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft] : null,
    }));
  }

  async function detectOn(canvas) {
    const det = await getNative();
    if (det) {
      try {
        const res = await det.detect(canvas);
        return res.filter((r) => r.rawValue).map((r) => ({ raw: r.rawValue, corners: r.cornerPoints && r.cornerPoints.length === 4 ? r.cornerPoints : boxCorners(r.boundingBox) }));
      } catch (_) { /* cae a zxing */ }
    }
    return zxingRead(canvas);
  }
  const boxCorners = (b) => [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];

  /** Busca todos los PDF417 de la foto. Prueba imagen normal, mejorada y girada. */
  async function findBarcodes(canvas) {
    const attempts = [
      () => canvas,
      () => enhance(canvas),
      () => enhance(canvas, { sharpen: true }),
      () => rotate(canvas, 90),
      () => rotate(canvas, 270),
      () => rotate(canvas, 180),
    ];
    const found = new Map(); // raw -> {raw, corners, canvas}
    for (let i = 0; i < attempts.length; i++) {
      const cv = attempts[i]();
      let res = [];
      try { res = await detectOn(cv); } catch (_) { res = []; }
      // un código es "válido" si el parser lo entiende
      for (const r of res) {
        if (!found.has(r.raw) && P.parseBarcode(r.raw)) found.set(r.raw, { ...r, canvas: cv });
      }
      // si ya hay algo con la imagen original/mejorada, no gastamos más intentos de giro
      if (found.size && i >= 2) break;
    }
    return [...found.values()];
  }

  /** Recorta, enderezado, la zona del dorso alrededor del código (donde está el domicilio). */
  function cropBack(canvas, corners, flip = false) {
    const [p0, p1, p2, p3] = corners;
    const cx = (p0.x + p1.x + p2.x + p3.x) / 4, cy = (p0.y + p1.y + p2.y + p3.y) / 4;
    const bw = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const bh = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    let ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    if (flip) ang += Math.PI;
    const W = bw * 1.4, H = bw * 1.0;
    const s = Math.max(1, Math.min(3, 1500 / W));
    const out = document.createElement('canvas');
    out.width = Math.round(W * s); out.height = Math.round(H * s);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.scale(s, s);
    ctx.translate(W / 2, H - bh / 2 - bw * 0.04);
    ctx.rotate(-ang);
    ctx.translate(-cx, -cy);
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  /* ---------- OCR ---------- */
  let workerP = null;
  function getWorker(onStatus) {
    if (!workerP) {
      workerP = (async () => {
        onStatus && onStatus('Descargando OCR en español (solo la primera vez)…');
        await loadScript(CDN.tesseract);
        const w = await Tesseract.createWorker('spa', 1, {});
        return w;
      })().catch((e) => { workerP = null; throw e; });
    }
    return workerP;
  }

  async function ocr(canvas, onStatus) {
    const w = await getWorker(onStatus);
    const { data } = await w.recognize(canvas);
    const lines = (data.lines && data.lines.length
      ? data.lines.map((l) => ({ text: l.text, conf: l.confidence }))
      : String(data.text || '').split('\n').map((t) => ({ text: t, conf: data.confidence })));
    return { lines, text: data.text || '', conf: data.confidence || 0 };
  }

  const KEYWORDS = /(DOMICILIO|DOCUMENTO|APELLIDO|NOMBRE|REPUBLICA|ARGENTIN|IDENTIDAD|NACIMIENTO|EJEMPLAR)/g;
  const strip = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  /** OCR de la foto completa probando orientaciones hasta que "parezca" un DNI. */
  async function ocrWholeBestOrientation(canvas, onStatus) {
    let best = null;
    for (const deg of [0, 90, 270, 180]) {
      const cv = enhance(deg ? rotate(canvas, deg) : canvas);
      const r = await ocr(cv, onStatus);
      const score = (strip(r.text).match(KEYWORDS) || []).length * 10 + P.extractDniNumbers(r.text).length;
      if (!best || score > best.score) best = { ...r, score };
      if (score >= 20) break;
    }
    return best;
  }

  /* ---------- procesar una foto ---------- */
  /** Devuelve { records:[...], info } con registros nuevos (sin fusionar). */
  async function processPhoto(blob, photoId, opts = {}) {
    const onStatus = opts.onStatus;
    const canvas = await decodeToCanvas(blob);
    const out = [];
    const notes = [];

    const codes = await findBarcodes(canvas);
    const seenDni = new Set();
    for (const c of codes) {
      const parsed = P.parseBarcode(c.raw);
      if (!parsed || seenDni.has(parsed.dni)) continue;
      seenDni.add(parsed.dni);
      let direccion = '', dirFlag = true;
      if (c.corners) {
        try {
          for (const flip of [false, true]) {
            const crop = enhance(cropBack(c.canvas, c.corners, flip));
            const r = await ocr(crop, onStatus);
            const back = P.parseBackLines(r.lines);
            if (back.direccion) {
              direccion = back.direccion;
              dirFlag = back.conf < OCR_CONF_OK;
              break;
            }
          }
        } catch (e) { notes.push('OCR domicilio: ' + e.message); }
      }
      out.push(P.makeRecord({
        nombre: parsed.nombreCompleto, dni: parsed.dni, direccion,
        flags: { nombre: false, dni: false, direccion: dirFlag }, fuente: 'código', photoId,
      }));
    }

    // Sin código (o el usuario pidió leer también frentes): OCR de la foto completa
    if (!codes.length || opts.ocrAlways) {
      try {
        const r = await ocrWholeBestOrientation(canvas, onStatus);
        const nums = P.extractDniNumbers(r.text).filter((n) => !seenDni.has(n));
        if (nums.length === 1) {
          const f = P.parseFrontLines(r.lines);
          const back = P.parseBackLines(r.lines);
          const nombre = f.apellido && f.nombre ? f.apellido + ', ' + f.nombre : '';
          out.push(P.makeRecord({
            nombre, dni: nums[0], direccion: back.direccion || '',
            flags: { nombre: true, dni: r.conf < OCR_CONF_OK, direccion: true }, fuente: 'OCR', photoId,
          }));
        } else if (nums.length > 1) {
          nums.forEach((n) => out.push(P.makeRecord({
            nombre: '', dni: n, direccion: '', flags: { nombre: true, dni: true, direccion: true }, fuente: 'OCR', photoId,
          })));
          notes.push('Varios DNI sin código: completar nombre y domicilio a mano');
        } else if (!codes.length) {
          notes.push('No se detectó ningún DNI');
        }
      } catch (e) {
        if (!codes.length) throw e;
        notes.push('OCR: ' + e.message);
      }
    }
    return { records: out, notes, width: canvas.width, height: canvas.height, canvas };
  }

  /** JPEG reducido para revisar luego la foto (no se guarda el original completo). */
  async function makeView(canvas, maxSide = 1400, q = 0.72) {
    const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
  }

  async function terminate() {
    if (workerP) { try { (await workerP).terminate(); } catch (_) {} workerP = null; }
  }

  return { processPhoto, makeView, terminate, decodeToCanvas, enhance, cropBack };
})();
