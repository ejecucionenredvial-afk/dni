# Lector de DNI (gratis, 100% en el teléfono)

Extrae **nombre completo, DNI y dirección** de fotos de DNI argentinos (varios DNI por foto), los muestra en una tabla editable y exporta a Excel/CSV. No hay servidor, no hay claves, no hay costos.

## Cómo lee (y qué esperar)

| Dato | Cómo se obtiene | Confiabilidad |
|---|---|---|
| Nombre y DNI | Código de barras PDF417 del **dorso** (BarcodeDetector de Android; respaldo zxing-wasm) | Muy alta: el código tiene corrección de errores |
| Dirección | OCR (Tesseract, español) sobre el domicilio impreso en el dorso | Media: en fotos borrosas queda en **Revisar** |
| Fotos sin código (frentes, dorsos ilegibles) | OCR de la foto completa | Baja: nombre y dirección quedan en **Revisar** |

- La dirección **no está en el código de barras**; siempre sale del OCR. Es el dato que más vas a revisar.
- Un campo con confianza baja o ilegible queda vacío con la marca roja **Revisar**. Nada se inventa ni se completa por suposición.
- El mismo DNI en varias fotos se fusiona en un solo registro (completa campos vacíos; si hay conflicto, marca Revisar). Nombres casi iguales con DNI distinto se marcan como **Posible duplicado**.

## Privacidad

- Las fotos **no salen del teléfono**. No hay backend ni API de IA.
- Lo único que se baja de internet (una vez; luego queda en caché): los programas de lectura (`tesseract.js`, `zxing-wasm`) y el idioma español de OCR, desde `cdn.jsdelivr.net`. No se les envía ninguna foto ni dato.
- Datos en el almacenamiento privado del navegador (IndexedDB) de ese teléfono. Por defecto se guarda solo una copia **reducida** de cada foto para poder revisarla; el original se descarta al procesarlo. Botones para **Borrar fotos** y **Borrar todo**.
- El Excel/CSV lleva únicamente 4 columnas, sin fotos. El respaldo `.json` sí contiene datos personales: guardalo en un lugar privado.
- Publicar la app (el código) no publica datos: los datos nunca se suben.

## Publicar gratis (GitHub Pages)

1. Creá un repositorio en GitHub (ej. `lector-dni`) y subí **solo** estos archivos a la raíz:
   `index.html, app.js, parser.js, xlsxmin.js, db.js, engine.js, sw.js, manifest.json, icon.svg, icon-192.png, icon-512.png`
   (la carpeta `tests` es opcional; no subas `tests/out`).
2. En el repo: **Settings → Pages → Deploy from a branch → main / (root) → Save**.
3. A los ~2 minutos queda en `https://TU_USUARIO.github.io/lector-dni/`.
4. Alternativa: Cloudflare Pages (gratis) arrastrando la carpeta.

## Usar en Android

1. Abrí la dirección en **Chrome** (con internet la primera vez) y elegí menú ⋮ → **Instalar aplicación / Agregar a la pantalla principal**.
2. **Importar:** botón *Elegir fotos* (en el selector de Android podés elegir de Google Fotos y marcar varias), o desde Google Fotos → *Compartir* → *Lector de DNI* (requiere haberla instalado).
3. Importá de a 100–150 fotos, tocá **Procesar** (elegí tanda de 25/50/100 si querés). Dejá la pantalla encendida y el teléfono cargando; la app pide mantener la pantalla activa.
4. Mirá la pestaña **Resultados**: filtrá *Por revisar*, tocá 📷 para ver la foto, corregí en la celda y tocá ✓ para marcar verificado.
5. **Exportar**: Excel (.xlsx) o CSV (separador `;`, abre bien en Excel en español).
6. Si se cierra el navegador, al volver ofrece continuar. Guardado automático en cada cambio; podés hacer **Copia de seguridad** e **Importar copia**.

## Probar antes de procesar las 500

Procesá primero 10–15 fotos reales (mezclando una borrosa, una con varios DNI y una sin código) y revisá cuántas direcciones quedan en *Revisar*. Si el OCR de domicilio rinde poco con tus fotos, conviene sacar las fotos más cerca y con luz pareja.

## Límites conocidos

- Si el navegador no tiene `BarcodeDetector` con PDF417, usa zxing-wasm (requiere bajarlo una vez).
- DNI viejos en libreta (sin PDF417) se leen solo por OCR → casi todo queda en *Revisar*.
- Varios frentes en una misma foto sin códigos: se detectan los números de DNI, pero nombre y dirección quedan para completar a mano.
- iPhone: `Compartir → app` no existe en iOS; el selector de archivos sí funciona.

## Pruebas incluidas

```
node tests/test_core.js            # parser, duplicados, CSV, genera xlsx
python3 tests/test_xlsx.py tests/out/prueba.xlsx   # verifica el xlsx con openpyxl
NODE_PATH=<node_modules con playwright y sharp> node tests/e2e.js   # flujo completo en Chromium
```
La prueba e2e simula los dos motores de lectura con datos ficticios; ver notas en el archivo.
