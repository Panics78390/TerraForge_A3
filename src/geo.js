import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_SIZES, LOGO } from './wizard.js';

// ======================================================================
// Import du monde réel.
//  - Relief : tuiles « Terrarium » (Mapzen / AWS Open Data), ~30 m de précision.
//  - Routes, forêts, eau, bâtiments : OpenStreetMap via l'API Overpass.
//  - Recherche de lieu : Nominatim (OpenStreetMap).
// ======================================================================

const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// Sentinel-2 cloudless 2016 par EOX (licence CC BY 4.0), environ 10 m par pixel.
const SAT_URL = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`;
export const SAT_CREDIT = 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const M_LAT = 111320;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function openGeoDialog() {
  return new Promise((resolve) => {
    const cfg = {
      name: 'MonTerrainReel', author: '',
      lat: 45.8992, lon: 6.1294,
      sizeIdx: 1, grid: 1024, cell: 4, maskRes: 2048,
      relief: true, altMode: 'real',
      satellite: true,
      roads: true, paths: false, landuse: true, trees: true, treeDensity: 40, buildings: true,
    };
    const root = document.createElement('div');
    root.id = 'wizard';
    root.innerHTML = `
      <div class="wz-box geo">
        <header class="wz-head"><div class="brand">${LOGO}<b>Terra<span>Forge</span></b></div><div class="wz-title">Importer une zone du monde réel</div></header>
        <section class="geo-map"><div id="geo-leaflet"></div></section>
        <aside class="geo-side wz-col"></aside>
        <footer class="wz-foot"><div class="wz-sum"></div><div class="spacer"></div>
          <button data-a="cancel">Annuler</button><button data-a="create" class="primary">✓ Créer la carte</button></footer>
      </div>`;
    document.body.append(root);
    const side = root.querySelector('.geo-side'), sum = root.querySelector('.wz-sum');
    const size = () => cfg.grid * cfg.cell;

    const map = L.map(root.querySelector('#geo-leaflet'), { zoomControl: true }).setView([cfg.lat, cfg.lon], 12);
    // Fond de carte. Le plan OpenStreetMap n'est autorisé que pour une page servie
    // en http(s) (version en ligne) ; pour un fichier local on affiche un fond
    // « relief » dessiné à partir des tuiles d'altitude, toujours disponible.
    const online = location.protocol.startsWith('http');
    const relief = reliefLayer();
    const satL = L.tileLayer('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', {
      maxNativeZoom: 14, maxZoom: 19, attribution: 'Sentinel-2 cloudless © EOX (Copernicus 2016)',
    });
    let satErr = 0;
    satL.on('tileerror', () => { if (++satErr === 3 && map.hasLayer(satL)) { map.removeLayer(satL); relief.addTo(map); } });
    if (online) {
      const plan = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs OpenStreetMap' });
      let errors = 0;
      plan.on('tileerror', () => { if (++errors === 3 && map.hasLayer(plan)) { map.removeLayer(plan); relief.addTo(map); } });
      plan.addTo(map);
      L.control.layers({ 'Plan': plan, 'Satellite': satL, 'Relief': relief }, null, { collapsed: false, position: 'topright' }).addTo(map);
    } else {
      satL.addTo(map);
      L.control.layers({ 'Satellite': satL, 'Relief': relief }, null, { collapsed: false, position: 'topright' }).addTo(map);
    }
    const rect = L.rectangle(boundsOf(cfg.lat, cfg.lon, size()), { color: '#d9a441', weight: 2, fillOpacity: 0.18, interactive: false }).addTo(map);
    const syncRect = () => {
      const c = map.getCenter();
      cfg.lat = c.lat; cfg.lon = c.lng;
      rect.setBounds(boundsOf(cfg.lat, cfg.lon, size()));
      const la = side.querySelector('[data-k=lat]'), lo = side.querySelector('[data-k=lon]');
      if (la && document.activeElement !== la) la.value = cfg.lat.toFixed(5);
      if (lo && document.activeElement !== lo) lo.value = cfg.lon.toFixed(5);
      sum.innerHTML = `<b>${esc(cfg.name)}</b> · ${(size() / 1000).toFixed(1)} km de côté · relief ${cfg.grid} × ${cfg.grid}, cellule ${cfg.cell} m · centre ${cfg.lat.toFixed(4)}, ${cfg.lon.toFixed(4)}`;
    };
    map.on('move', syncRect);
    setTimeout(() => map.invalidateSize(), 50);

    const close = (r) => { map.remove(); root.remove(); resolve(r); };
    root.querySelector('[data-a=cancel]').onclick = () => close(null);
    root.querySelector('[data-a=create]').onclick = () => close({ ...cfg, name: cfg.name.trim().replace(/[^A-Za-z0-9_]/g, '_') || 'MonTerrainReel' });

    function check(label, key, sub = '') {
      const l = document.createElement('label');
      l.className = 'wz-block-head geo-opt';
      l.innerHTML = `<div><b>${label}</b><small>${sub}</small></div><input type="checkbox" class="switch" ${cfg[key] ? 'checked' : ''}>`;
      l.querySelector('input').onchange = (e) => { cfg[key] = e.target.checked; };
      return l;
    }

    function render() {
      side.innerHTML = `
        <h2>Monde réel</h2>
        <p class="note">Cherche un lieu, puis déplace la carte : le carré jaune reste au centre et montre la zone qui deviendra ta map.</p>
        ${location.protocol.startsWith('http') ? '' : '<p class="note warn">Fichier local : fonds « satellite » et « relief ». Le plan avec les noms de lieux s\'affiche dans la version en ligne.</p>'}
        <div class="row"><input type="text" data-k="q" placeholder="Ville, lieu, adresse…"><button class="small" data-a="search">Chercher</button></div>
        <div class="list" data-k="results"></div>
        <div class="row"><label>Latitude</label><input type="number" step="0.0001" data-k="lat"></div>
        <div class="row"><label>Longitude</label><input type="number" step="0.0001" data-k="lon"></div>
        <h3>Taille de la carte</h3>
        <div class="row"><select data-k="size">${MAP_SIZES.map((m, i) => `<option value="${i}" ${i === cfg.sizeIdx ? 'selected' : ''}>${m.side} m · ${m.label}</option>`).join('')}</select></div>
        <h3>Données à importer</h3>
        <div data-k="opts"></div>
        <div class="row"><label>Altitudes</label><select data-k="alt"><option value="real">Réelles</option><option value="shift">Point bas ramené à 5 m</option></select></div>
        <div class="row"><label>Arbres par hectare</label><input type="range" min="5" max="150" step="5" value="${cfg.treeDensity}" data-k="dens"><output>${cfg.treeDensity}</output></div>
        <h3>Projet</h3>
        <div class="row"><label>Nom de la carte</label><input type="text" data-k="name" value="${esc(cfg.name)}"></div>
        <p class="note">Relief : données mondiales d'environ 30 m de précision (Mapzen / AWS). Routes, forêts, eau et bâtiments : © contributeurs OpenStreetMap (licence ODbL, à créditer si tu publies la map).</p>`;
      const opts = side.querySelector('[data-k=opts]');
      opts.append(
        check('Relief', 'relief', 'Altitudes réelles, fonds marins compris'),
        check('Image satellite', 'satellite', 'Vraie photo satellite (10 m par pixel) plaquée sur le terrain'),
        check('Routes', 'roads', 'Routes, rues et chemins de terre'),
        check('Sentiers', 'paths', 'Sentiers piétons et pistes cyclables'),
        check('Occupation du sol', 'landuse', 'Forêts, champs, plages, roche, eau : peints au sol'),
        check('Arbres', 'trees', 'Plante les forêts avec un mélange d\'essences'),
        check('Bâtiments', 'buildings', 'Une maison placée et orientée par bâtiment'),
      );
      const $ = (k) => side.querySelector(`[data-k=${k}]`);
      $('alt').value = cfg.altMode;
      $('alt').onchange = (e) => (cfg.altMode = e.target.value);
      $('dens').oninput = (e) => { cfg.treeDensity = +e.target.value; e.target.nextElementSibling.textContent = e.target.value; };
      $('name').oninput = (e) => { cfg.name = e.target.value; syncRect(); };
      $('size').onchange = (e) => {
        cfg.sizeIdx = +e.target.value;
        const m = MAP_SIZES[cfg.sizeIdx];
        cfg.grid = m.grid; cfg.cell = m.cell;
        syncRect();
        map.fitBounds(rect.getBounds().pad(0.3));
      };
      const go = () => { const la = parseFloat($('lat').value), lo = parseFloat($('lon').value); if (isFinite(la) && isFinite(lo)) map.setView([la, lo]); };
      $('lat').onchange = go; $('lon').onchange = go;
      const search = async () => {
        const q = $('q').value.trim();
        if (!q) return;
        const out = $('results');
        out.innerHTML = '<p class="note">Recherche…</p>';
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=fr&q=${encodeURIComponent(q)}`);
          const list = await r.json();
          out.innerHTML = list.length ? '' : '<p class="note">Aucun résultat.</p>';
          for (const it of list) {
            const d = document.createElement('div');
            d.className = 'item';
            d.innerHTML = `<div class="grow"><div class="sub" style="white-space:normal">${esc(it.display_name)}</div></div>`;
            d.onclick = () => { map.setView([+it.lat, +it.lon], 13); out.innerHTML = ''; };
            out.append(d);
          }
        } catch {
          out.innerHTML = '<p class="note warn">Recherche impossible (pas de connexion ?). Tu peux saisir la latitude et la longitude.</p>';
        }
      };
      side.querySelector('[data-a=search]').onclick = search;
      $('q').onkeydown = (e) => { if (e.key === 'Enter') search(); };
      syncRect();
    }
    render();
    map.fitBounds(rect.getBounds().pad(0.3));
  });
}

// Fond de carte de secours : relief ombré calculé depuis les tuiles d'altitude.
function reliefLayer() {
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const max = 2 ** coords.z;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const im = ctx.getImageData(0, 0, 256, 256), d = im.data;
        const h = new Float32Array(65536);
        for (let k = 0; k < 65536; k++) h[k] = d[k * 4] * 256 + d[k * 4 + 1] + d[k * 4 + 2] / 256 - 32768;
        const res = 156543 / max; // m/px approximatif
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          const k = y * 256 + x, e = h[k];
          const dx = h[y * 256 + Math.min(255, x + 1)] - h[y * 256 + Math.max(0, x - 1)];
          const dy = h[Math.min(255, y + 1) * 256 + x] - h[Math.max(0, y - 1) * 256 + x];
          const sh = Math.max(0.45, Math.min(1.35, 1 - ((dx + dy) / res) * 1.4));
          let r, g, b;
          if (e <= 0) { r = 70; g = 120; b = 160; }
          else {
            const t = Math.min(1, e / 2500);
            r = 120 + 110 * t; g = 150 + 50 * t - 40 * t * t; b = 95 + 100 * t * t;
          }
          d[k * 4] = r * (e <= 0 ? 1 : sh); d[k * 4 + 1] = g * (e <= 0 ? 1 : sh); d[k * 4 + 2] = b * (e <= 0 ? 1 : sh); d[k * 4 + 3] = 255;
        }
        ctx.putImageData(im, 0, 0);
        done(null, c);
      };
      img.onerror = () => done(new Error('tuile'), c);
      img.src = ELEV_URL(coords.z, ((coords.x % max) + max) % max, coords.y);
      return c;
    },
  });
  return new Layer({ maxNativeZoom: 14, maxZoom: 19, attribution: 'Relief : Mapzen / AWS Open Data' });
}

function boundsOf(lat, lon, size) {
  const dLat = size / 2 / M_LAT, dLon = size / 2 / (M_LAT * Math.cos((lat * Math.PI) / 180));
  return [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
}

// Projection locale : (lat, lon) -> position (x, z) dans le monde 3D, z = 0 au nord.
function projector(cfg) {
  const S = cfg.grid * cfg.cell;
  const mLon = M_LAT * Math.cos((cfg.lat * Math.PI) / 180);
  return {
    S,
    toWorld: (lat, lon) => [(lon - cfg.lon) * mLon + S / 2, S / 2 - (lat - cfg.lat) * M_LAT],
    toGeo: (x, z) => [cfg.lat + (S / 2 - z) / M_LAT, cfg.lon + (x - S / 2) / mLon],
  };
}

// ---------- Relief ----------
export async function fetchElevation(cfg, progress = () => {}) {
  const N = cfg.grid, cell = cfg.cell, pr = projector(cfg);
  const [[s, w], [n, e]] = boundsOf(cfg.lat, cfg.lon, pr.S + 4 * cell);
  const px = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
  const py = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 256 * 2 ** z;
  let z = 14, tx0, tx1, ty0, ty1;
  for (; z >= 5; z--) {
    tx0 = Math.floor(px(w, z) / 256); tx1 = Math.floor(px(e, z) / 256);
    ty0 = Math.floor(py(n, z) / 256); ty1 = Math.floor(py(s, z) / 256);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 144) break;
  }
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1, W = nx * 256, H = ny * 256;
  const mosaic = new Float32Array(W * H);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  let done = 0, failed = 0;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  async function worker() {
    for (;;) {
      const job = jobs.pop();
      if (!job) return;
      const [tx, ty] = job;
      try {
        const max = 2 ** z;
        const r = await fetch(ELEV_URL(z, ((tx % max) + max) % max, ty));
        if (!r.ok) throw new Error(r.status);
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        ctx.clearRect(0, 0, 256, 256);
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data;
        const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
        for (let yy = 0; yy < 256; yy++) for (let xx = 0; xx < 256; xx++) {
          const k = (yy * 256 + xx) * 4;
          mosaic[(oy + yy) * W + ox + xx] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
        }
      } catch { failed++; }
      progress(`Relief : ${++done} / ${nx * ny} tuiles`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed === nx * ny) throw new Error('Impossible de télécharger le relief (connexion internet ?)');

  const heights = new Float32Array(N * N);
  const X0 = tx0 * 256, Y0 = ty0 * 256;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const [lat, lon] = pr.toGeo(i * cell, j * cell);
    const fx = Math.min(W - 1.001, Math.max(0, px(lon, z) - X0 - 0.5)), fy = Math.min(H - 1.001, Math.max(0, py(lat, z) - Y0 - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
    const a = mosaic[y0 * W + x0], b = mosaic[y0 * W + x0 + 1], c = mosaic[(y0 + 1) * W + x0], d = mosaic[(y0 + 1) * W + x0 + 1];
    heights[j * N + i] = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  // Les données sont plus grossières que la grille : on adoucit les facettes.
  const res = (156543.03 * Math.cos((cfg.lat * Math.PI) / 180)) / 2 ** z;
  const rad = Math.min(12, Math.round(Math.max(res, 25) / cell / 2));
  if (rad >= 1) { boxBlur(heights, N, rad); boxBlur(heights, N, rad); }

  if (cfg.altMode === 'shift') {
    let min = Infinity;
    for (const h of heights) if (h < min) min = h;
    if (min > 5) for (let k = 0; k < heights.length; k++) heights[k] -= min - 5;
  }
  return heights;
}

function boxBlur(a, N, r) {
  const tmp = new Float32Array(N);
  const pass = (get, set) => {
    for (let line = 0; line < N; line++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += get(line, Math.min(N - 1, Math.max(0, k)));
      for (let k = 0; k < N; k++) {
        tmp[k] = sum / (2 * r + 1);
        sum += get(line, Math.min(N - 1, k + r + 1)) - get(line, Math.max(0, k - r));
      }
      for (let k = 0; k < N; k++) set(line, k, tmp[k]);
    }
  };
  pass((j, i) => a[j * N + i], (j, i, v) => (a[j * N + i] = v));
  pass((i, j) => a[j * N + i], (i, j, v) => (a[j * N + i] = v));
}

// ---------- Image satellite ----------
// Renvoie un canvas R x R couvrant exactement la carte (haut = nord).
export async function fetchSatellite(cfg, R, progress = () => {}) {
  const pr = projector(cfg), S = pr.S;
  const [[s, w], [n, e]] = boundsOf(cfg.lat, cfg.lon, S + 2 * cfg.cell);
  const px = (lon, z) => ((lon + 180) / 360) * 2 ** z;
  const py = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
  const lonOf = (x, z) => (x / 2 ** z) * 360 - 180;
  const latOf = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
  let z = 14, tx0, tx1, ty0, ty1;
  for (; z >= 5; z--) {
    tx0 = Math.floor(px(w, z)); tx1 = Math.floor(px(e, z));
    ty0 = Math.floor(py(n, z)); ty1 = Math.floor(py(s, z));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 196) break;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = R;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#5c763a';
  ctx.fillRect(0, 0, R, R);
  ctx.imageSmoothingQuality = 'high';
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  const total = jobs.length;
  let done = 0, ok = 0;
  // Position dans le canvas : même repère que le masque (voir Terrain.worldToMask).
  const toPx = (lat, lon) => { const [x, zz] = pr.toWorld(lat, lon); return [(x / S) * R, ((zz + cfg.cell) / S) * R]; };
  async function worker() {
    for (;;) {
      const job = jobs.pop();
      if (!job) return;
      const [tx, ty] = job;
      try {
        const r = await fetch(SAT_URL(z, tx, ty));
        if (!r.ok) throw new Error(r.status);
        const bmp = await createImageBitmap(await r.blob());
        const [x0, y0] = toPx(latOf(ty, z), lonOf(tx, z));
        const [x1, y1] = toPx(latOf(ty + 1, z), lonOf(tx + 1, z));
        ctx.drawImage(bmp, x0, y0, x1 - x0 + 0.5, y1 - y0 + 0.5);
        ok++;
      } catch { /* tuile manquante */ }
      progress(`Image satellite : ${++done} / ${total} tuiles`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (!ok) throw new Error('image satellite indisponible');
  return canvas;
}

// ---------- OpenStreetMap ----------
export async function fetchOSM(cfg, progress = () => {}) {
  const [[s, w], [n, e]] = boundsOf(cfg.lat, cfg.lon, cfg.grid * cfg.cell);
  const bb = `(${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)})`;
  const parts = [];
  if (cfg.roads || cfg.paths) parts.push(`way["highway"]${bb};`);
  if (cfg.buildings) parts.push(`way["building"]${bb};`);
  if (cfg.landuse || cfg.trees) {
    parts.push(`way["natural"~"^(wood|water|scrub|heath|beach|sand|bare_rock|scree|wetland)$"]${bb};`);
    parts.push(`way["landuse"~"^(forest|farmland|meadow|grass|orchard|vineyard|industrial|commercial|retail|quarry|reservoir|basin)$"]${bb};`);
    parts.push(`way["waterway"="riverbank"]${bb};`);
    parts.push(`relation["type"="multipolygon"]["natural"~"^(wood|water|scrub|wetland)$"]${bb};`);
    parts.push(`relation["type"="multipolygon"]["landuse"~"^(forest|farmland|meadow|reservoir)$"]${bb};`);
  }
  if (!parts.length) return { elements: [] };
  const query = `[out:json][timeout:60];(${parts.join('')});out geom;`;
  let lastErr;
  for (let n = 0; n < OVERPASS.length; n++) {
    const ctl = new AbortController();
    const t0 = Date.now();
    const label = `OpenStreetMap : téléchargement des routes, forêts et bâtiments (serveur ${n + 1} sur ${OVERPASS.length})`;
    const timer = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      progress(`${label}… ${sec} s`);
      if (sec >= 75) ctl.abort();
    }, 1000);
    try {
      progress(`${label}…`);
      const r = await fetch(OVERPASS[n], { method: 'POST', signal: ctl.signal, body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error(`serveur occupé, code ${r.status}`);
      const json = await r.json();
      if (json.remark && !(json.elements || []).length) throw new Error(json.remark);
      return json;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('pas de réponse après 75 secondes') : err;
    } finally { clearInterval(timer); }
  }
  throw lastErr;
}

const ROAD_TYPES = {
  motorway: 1, trunk: 1, primary: 1, motorway_link: 1, trunk_link: 1, primary_link: 1,
  secondary: 2, tertiary: 2, secondary_link: 2, tertiary_link: 2,
  residential: 4, unclassified: 4, living_street: 4, service: 4, pedestrian: 4,
  track: 3,
  path: 5, footway: 5, cycleway: 5, bridleway: 5, steps: 5,
};

// Classe d'occupation du sol -> rôle de surface (voir surfaces.js).
function landClass(t) {
  const nat = t.natural, lu = t.landuse;
  if (nat === 'water' || lu === 'reservoir' || lu === 'basin' || t.waterway === 'riverbank') return 'water';
  if (nat === 'wood' || lu === 'forest') return 'forest';
  if (nat === 'beach' || nat === 'sand') return 'sand';
  if (nat === 'bare_rock' || nat === 'scree' || lu === 'quarry') return 'rock';
  if (nat === 'scrub' || nat === 'heath' || lu === 'farmland' || lu === 'orchard' || lu === 'vineyard') return 'drygrass';
  if (nat === 'wetland') return 'water';
  if (lu === 'meadow' || lu === 'grass') return 'grass';
  if (lu === 'industrial' || lu === 'commercial' || lu === 'retail') return 'concrete';
  return null;
}

// Assemble les tronçons d'un multipolygone en anneaux fermés.
function stitchRings(ways) {
  const rings = [], open = ways.map((w) => w.slice());
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  while (open.length) {
    let cur = open.pop();
    for (let guard = 0; guard < 2000 && !same(cur[0], cur[cur.length - 1]); guard++) {
      const end = cur[cur.length - 1];
      const k = open.findIndex((w) => same(w[0], end) || same(w[w.length - 1], end));
      if (k < 0) break;
      let nxt = open.splice(k, 1)[0];
      if (!same(nxt[0], end)) nxt = nxt.reverse();
      cur = cur.concat(nxt.slice(1));
    }
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}

// Convertit la réponse Overpass en éléments placés dans le monde 3D.
export function parseOSM(json, cfg) {
  const pr = projector(cfg), S = pr.S;
  const proj = (g) => g.map((p) => pr.toWorld(p.lat, p.lon));
  const inside = ([x, z]) => x >= 0 && z >= 0 && x <= S && z <= S;
  const roads = [], buildings = [], areas = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const pts = proj(el.geometry);
      if (t.highway) {
        const type = ROAD_TYPES[t.highway];
        if (!type || t.tunnel === 'yes' || t.area === 'yes') continue;
        if (type === 5 ? !cfg.paths : !cfg.roads) continue;
        // Découpe aux bords de la carte.
        let seg = [];
        const flush = () => { if (seg.length >= 2) roads.push({ type, raw: true, points: seg }); seg = []; };
        for (const p of pts) { if (inside(p)) seg.push([round(p[0]), round(p[1])]); else flush(); }
        flush();
      } else if (t.building && cfg.buildings) {
        if (pts.length < 4) continue;
        let cx = 0, cz = 0, area = 0, best = 0, ang = 0;
        for (let k = 0; k < pts.length - 1; k++) {
          const [x0, z0] = pts[k], [x1, z1] = pts[k + 1];
          cx += x0; cz += z0; area += x0 * z1 - x1 * z0;
          const len = Math.hypot(x1 - x0, z1 - z0);
          if (len > best) { best = len; ang = Math.atan2(z1 - z0, x1 - x0); }
        }
        cx /= pts.length - 1; cz /= pts.length - 1; area = Math.abs(area) / 2;
        if (area < 12 || !inside([cx, cz])) continue;
        buildings.push({ x: cx, z: cz, rot: -ang, area });
      } else {
        const cls = landClass(t);
        if (cls && pts.length >= 3) areas.push({ cls, rings: [pts] });
      }
    } else if (el.type === 'relation' && el.members) {
      const cls = landClass(t);
      if (!cls) continue;
      const ways = el.members.filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1).map((m) => proj(m.geometry));
      const rings = stitchRings(ways);
      if (rings.length) areas.push({ cls, rings });
    }
  }
  return { roads, buildings, areas };
}
const round = (v) => Math.round(v * 100) / 100;

// Dessine une classe d'occupation du sol dans un masque (Uint8Array R x R, 1 = couvert).
export function rasterizeAreas(areas, cls, terrain) {
  const R = terrain.maskRes;
  const c = document.createElement('canvas');
  c.width = c.height = R;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  let any = false;
  for (const a of areas) {
    if (a.cls !== cls) continue;
    any = true;
    ctx.beginPath();
    for (const ring of a.rings) {
      ring.forEach(([x, z], k) => {
        const [px, py] = terrain.worldToMask(x, z);
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  if (!any) return null;
  const d = ctx.getImageData(0, 0, R, R).data;
  const out = new Uint8Array(R * R);
  for (let k = 0; k < R * R; k++) out[k] = d[k * 4 + 3] > 127 ? 1 : 0;
  return out;
}
