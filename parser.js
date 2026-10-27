/* parser.js — lógica pura (sin DOM): interpreta el código PDF417 y el texto OCR del DNI,
   normaliza datos, detecta duplicados y fusiona registros. Funciona en navegador y en Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DniParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const stripAccents = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const digits = (s) => (s || '').replace(/\D/g, '');
  const normName = (s) =>
    stripAccents(clean(s)).toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();

  function validDni(d) {
    return /^\d{7,8}$/.test(d) && Number(d) >= 1000000;
  }

  const NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]*$/;
  const isName = (s) => !!s && s.length >= 2 && NAME_RE.test(s);

  /** Interpreta el texto crudo del PDF417 del DNI argentino (tarjeta).
   *  Formato nuevo: trámite@APELLIDO@NOMBRE@SEXO@DNI@EJEMPLAR@NACIMIENTO@EMISIÓN@...
   *  Devuelve null si no reconoce el patrón (no inventa nada). */
  function parseBarcode(raw) {
    if (!raw || raw.indexOf('@') < 0) return null;
    const f = raw.split('@').map((x) => clean(x));
    let apellido = null, nombre = null, dni = null;

    // Patrón: APELLIDO @ NOMBRE @ SEXO @ DNI
    for (let i = 0; i + 3 < f.length; i++) {
      if (isName(f[i]) && isName(f[i + 1]) && /^[MFX]$/i.test(f[i + 2]) && /^\d{7,8}$/.test(f[i + 3])) {
        apellido = f[i]; nombre = f[i + 1]; dni = f[i + 3];
        break;
      }
    }
    // Patrón alternativo (formato anterior): DNI @ EJEMPLAR @ APELLIDO @ NOMBRE
    if (!dni) {
      for (let i = 0; i + 3 < f.length; i++) {
        if (/^\d{7,8}$/.test(f[i]) && /^[A-Z]$/i.test(f[i + 1]) && isName(f[i + 2]) && isName(f[i + 3])) {
          dni = f[i]; apellido = f[i + 2]; nombre = f[i + 3];
          break;
        }
      }
    }
    if (!dni || !validDni(dni)) return null;
    return {
      dni,
      apellido: apellido.toUpperCase(),
      nombre: nombre.toUpperCase(),
      nombreCompleto: apellido.toUpperCase() + ', ' + nombre.toUpperCase(),
    };
  }

  /** lines: [{text, conf}] o string. Busca el domicilio impreso en el dorso. */
  function parseBackLines(input) {
    const lines = toLines(input);
    const idx = lines.findIndex((l) => /DOMICILIO/.test(stripAccents(l.text).toUpperCase()));
    if (idx < 0) return { direccion: null, conf: 0 };
    const STOP = /(LUGAR\s*DE\s*NAC|NACIMIENTO|PULGAR|IDENTIFICAD|TRAMITE|EJEMPLAR|HUELLA|FECHA|SEXO|PLACE|BIRTH)/;
    const used = [];
    const first = lines[idx].text
      .replace(/^.*?DOMICILIO\s*[:/.\-]*\s*(\/?\s*ADDRESS)?\s*[:.\-]*/i, '')
      .trim();
    if (first && !STOP.test(stripAccents(first).toUpperCase())) used.push({ text: first, conf: lines[idx].conf });
    for (let i = idx + 1; i < lines.length && used.length < 3; i++) {
      const up = stripAccents(lines[i].text).toUpperCase();
      if (STOP.test(up)) break;
      if (lines[i].text.length < 3) continue;
      used.push(lines[i]);
    }
    if (!used.length) return { direccion: null, conf: 0 };
    let dir = used.map((u) => u.text).join(' ');
    dir = dir.replace(/[^\p{L}\p{N}.,°º\-/ ]/gu, ' ').replace(/\s+/g, ' ').replace(/^[\s.,\-/]+|[\s.,\-/]+$/g, '');
    if (dir.length < 4) return { direccion: null, conf: 0 };
    const conf = Math.min(...used.map((u) => (typeof u.conf === 'number' ? u.conf : 0)));
    return { direccion: dir, conf };
  }

  /** Lee frente: número de documento, apellido y nombre. */
  function parseFrontLines(input) {
    const lines = toLines(input);
    const out = { dni: null, apellido: null, nombre: null, conf: 0 };
    const confs = [];
    const nums = extractDniNumbers(lines.map((l) => l.text).join('\n'));
    if (nums.length === 1) out.dni = nums[0];
    const nextValue = (i) => {
      for (let k = i + 1; k < Math.min(lines.length, i + 3); k++) {
        const t = clean(lines[k].text.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]/g, ' '));
        if (isName(t) && t.length >= 2 && !/APELLIDO|NOMBRE|SEXO|NACIONALIDAD|DOCUMENTO|SURNAME|NAME/i.test(stripAccents(t))) {
          return { v: t, conf: lines[k].conf };
        }
      }
      return null;
    };
    lines.forEach((l, i) => {
      const up = stripAccents(l.text).toUpperCase();
      if (!out.apellido && /\bAPELLIDO/.test(up)) {
        const v = nextValue(i);
        if (v) { out.apellido = v.v.toUpperCase(); confs.push(v.conf); }
      } else if (!out.nombre && /\bNOMBRE/.test(up) && !/LUGAR/.test(up)) {
        const v = nextValue(i);
        if (v) { out.nombre = v.v.toUpperCase(); confs.push(v.conf); }
      }
    });
    out.conf = confs.length ? Math.min(...confs.filter((c) => typeof c === 'number')) : 0;
    return out;
  }

  /** Números con formato de DNI (con o sin puntos), sin repetir. */
  function extractDniNumbers(text) {
    const res = new Set();
    const re = /(?<![\d])(\d{1,2})[.\s]?(\d{3})[.\s]?(\d{3})(?![\d])/g;
    let m;
    while ((m = re.exec(text || ''))) {
      const d = m[1] + m[2] + m[3];
      if (validDni(d)) res.add(d);
    }
    return [...res];
  }

  function toLines(input) {
    if (Array.isArray(input)) {
      return input.map((l) => ({ text: clean(l.text), conf: l.conf })).filter((l) => l.text);
    }
    return String(input || '').split(/\r?\n/).map((t) => ({ text: clean(t), conf: 0 })).filter((l) => l.text);
  }

  /* ---------- Registros, duplicados y fusión ---------- */

  function newId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function makeRecord({ nombre = '', dni = '', direccion = '', flags = {}, fuente = 'manual', photoId = null }) {
    const r = {
      id: newId(),
      nombre: nombre || '',
      dni: dni || '',
      direccion: direccion || '',
      flags: {
        nombre: !nombre || !!flags.nombre,
        dni: !dni || !!flags.dni,
        direccion: !direccion || !!flags.direccion,
      },
      verificado: false,
      fuente,
      photoIds: photoId ? [photoId] : [],
      notas: '',
      createdAt: Date.now(),
    };
    return r;
  }

  function estadoOf(r) {
    if (r.verificado) return 'Verificado';
    return r.flags.nombre || r.flags.dni || r.flags.direccion ? 'Revisar' : 'OK';
  }

  /** Fusiona un registro entrante con uno existente que tenga el mismo DNI.
   *  Completa campos vacíos; ante conflicto conserva el existente y pide revisión. */
  function mergeInto(existing, incoming) {
    let changed = false;
    for (const k of ['nombre', 'direccion']) {
      if (!existing[k] && incoming[k]) {
        existing[k] = incoming[k];
        existing.flags[k] = incoming.flags[k];
        changed = true;
      } else if (existing[k] && incoming[k] && normName(existing[k]) !== normName(incoming[k])) {
        if (!incoming.flags[k] && existing.flags[k]) {
          existing[k] = incoming[k];
          existing.flags[k] = false;
          changed = true;
        } else if (!incoming.flags[k] && !existing.flags[k]) {
          existing.flags[k] = true;
          existing.notas = clean((existing.notas || '') + ' Conflicto en ' + k + ': ' + incoming[k]);
          changed = true;
        }
      }
    }
    for (const p of incoming.photoIds) {
      if (!existing.photoIds.includes(p)) { existing.photoIds.push(p); changed = true; }
    }
    return changed;
  }

  /** Agrega registros a la lista evitando repetir el mismo DNI. Devuelve {added, merged}. */
  function addWithDedupe(list, incoming) {
    const added = [], merged = [];
    for (const rec of incoming) {
      const d = rec.dni && validDni(digits(rec.dni)) ? digits(rec.dni) : null;
      const hit = d ? list.find((r) => digits(r.dni) === d) : null;
      if (hit) {
        if (mergeInto(hit, rec)) merged.push(hit);
      } else {
        list.push(rec);
        added.push(rec);
      }
    }
    return { added, merged };
  }

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return Math.max(m, n);
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /** Devuelve Map(id -> motivo) con posibles duplicados (mismo DNI o nombres casi iguales). */
  function findDuplicates(records) {
    const out = new Map();
    const byDni = new Map();
    for (const r of records) {
      const d = digits(r.dni);
      if (d.length >= 7) {
        if (!byDni.has(d)) byDni.set(d, []);
        byDni.get(d).push(r);
      }
    }
    for (const [d, arr] of byDni) {
      if (arr.length > 1) arr.forEach((r) => out.set(r.id, 'Mismo DNI ' + d));
    }
    const named = records.filter((r) => normName(r.nombre).length >= 8);
    for (let i = 0; i < named.length; i++) {
      const a = normName(named[i].nombre);
      for (let j = i + 1; j < named.length; j++) {
        const b = normName(named[j].nombre);
        if (Math.abs(a.length - b.length) > 2) continue;
        if (lev(a, b) <= 2) {
          if (!out.has(named[i].id)) out.set(named[i].id, 'Nombre parecido a ' + named[j].nombre);
          if (!out.has(named[j].id)) out.set(named[j].id, 'Nombre parecido a ' + named[i].nombre);
        }
      }
    }
    return out;
  }

  /** Filas para exportar: solo nombre, DNI, dirección y estado. */
  function exportRows(records, dups) {
    return records.map((r) => {
      let estado = estadoOf(r);
      if (dups && dups.has(r.id)) estado += ' (posible duplicado)';
      return [
        r.nombre || (r.flags.nombre ? 'Revisar' : ''),
        r.dni || (r.flags.dni ? 'Revisar' : ''),
        r.direccion || (r.flags.direccion ? 'Revisar' : ''),
        estado,
      ];
    });
  }

  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+@\t\r]/.test(s)) s = "'" + s; // evita fórmulas al abrir en Excel
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(header, rows) {
    return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }

  return {
    clean, normName, digits, validDni, estadoOf,
    parseBarcode, parseBackLines, parseFrontLines, extractDniNumbers,
    makeRecord, mergeInto, addWithDedupe, findDuplicates, exportRows, toCsv, lev,
  };
});
