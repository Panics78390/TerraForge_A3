// Exports pour les jeux autres qu'Arma 3 / DayZ : Roblox, Fortnite (UEFN), Unreal, Unity, générique.
import { zipSync, zlibSync, strToU8 } from 'fflate';
import { heightmapASC, satCanvas, canvasToPNG } from './exporters.js';

// ---------- PNG (niveaux de gris 8 / 16 bits, ou RVB 8 bits) ----------
let CRC = null;
function crc32(buf) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
// bytesPerPixel : 1 (gris 8 bits), 2 (gris 16 bits, gros-boutiste), 3 (RVB)
export function encodePNG(pixels, w, h, bytesPerPixel) {
  const stride = w * bytesPerPixel, raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = bytesPerPixel === 2 ? 16 : 8;
  ihdr[9] = bytesPerPixel === 3 ? 2 : 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 4 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- Relief ----------
// Ré-échantillonne le relief sur n x n points (ligne 0 = nord).
export function resampleHeights(T, n) {
  const N = T.N, out = new Float32Array(n * n);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const fx = (i / (n - 1)) * (N - 1), fy = (j / (n - 1)) * (N - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
    const u = fx - x0, v = fy - y0, H = T.heights;
    const h = (H[y0 * N + x0] * (1 - u) + H[y0 * N + x1] * u) * (1 - v) + (H[y1 * N + x0] * (1 - u) + H[y1 * N + x1] * u) * v;
    out[j * n + i] = h;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  if (max - min < 0.01) max = min + 1;
  return { data: out, min, max };
}
// 16 bits : min -> 0, max -> 65535. Renvoie des octets gros-boutistes (PNG) ou petit-boutistes (RAW).
function heights16(hm, n, { littleEndian = false, flipV = false } = {}) {
  const out = new Uint8Array(n * n * 2), k = 65535 / (hm.max - hm.min);
  for (let j = 0; j < n; j++) {
    const src = (flipV ? n - 1 - j : j) * n;
    for (let i = 0; i < n; i++) {
      const v = Math.round((hm.data[src + i] - hm.min) * k), o = (j * n + i) * 2;
      if (littleEndian) { out[o] = v & 255; out[o + 1] = v >> 8; } else { out[o] = v >> 8; out[o + 1] = v & 255; }
    }
  }
  return out;
}
function heights8(hm, n) {
  const out = new Uint8Array(n * n), k = 255 / (hm.max - hm.min);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((hm.data[i] - hm.min) * k);
  return out;
}

// ---------- Surfaces ----------
// Index de surface de chaque pixel d'une image n x n couvrant toute la carte.
function surfaceGrid(T, n, flipV = false) {
  const R = T.maskRes, out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = Math.min(R - 1, Math.floor(((flipV ? n - 1 - j : j) + 0.5) * R / n));
    for (let i = 0; i < n; i++) out[j * n + i] = T.surf[y * R + Math.min(R - 1, Math.floor((i + 0.5) * R / n))];
  }
  return out;
}
function usedSurfaces(T, grid) {
  const seen = new Set(grid);
  return T.surfaces.map((s, i) => ({ s, i })).filter(({ i }) => seen.has(i));
}
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

// ---------- Objets et routes (formats neutres) ----------
function objectsCSV(state) {
  const { terrain: T, objects: O } = state;
  const names = new Map(O.library.map((e) => [e.id, e.tbName || e.name]));
  const f = (v, d = 3) => (Math.round(v * 10 ** d) / 10 ** d).toString();
  const rows = ['modele;est_m;nord_m;altitude_m;cap_deg;tangage_deg;roulis_deg;echelle'];
  for (const o of O.objects) {
    const yaw = (((-o.rot * 180) / Math.PI) % 360 + 360) % 360;
    rows.push([names.get(o.lib), f(o.x), f(T.north(o.z)), f(T.heightAt(o.x, o.z) + (o.dy || 0)), f(yaw, 2), f((-(o.rx || 0) * 180) / Math.PI, 2), f((-(o.rz || 0) * 180) / Math.PI, 2), f(o.scale)].join(';'));
  }
  return rows.join('\r\n') + '\r\n';
}
function roadsJSON(state) {
  const { terrain: T, roads: R } = state;
  const types = new Map((R.types || []).map((t) => [t.id, t]));
  return JSON.stringify(R.roads.filter((r) => r.points.length >= 2).map((r) => ({
    type: types.get(r.type)?.name || r.type, largeur_m: types.get(r.type)?.width,
    points: r.points.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(T.north(z) * 100) / 100, Math.round(T.heightAt(x, z) * 100) / 100]),
  })), null, 1);
}

export const HEIGHTMAP_SIZES = {
  unreal: [505, 1009, 2017, 4033, 8129],
  unity: [513, 1025, 2049, 4097],
  roblox: [512, 1024, 2048, 4096],
  generic: [513, 1025, 2049, 4097],
};
export function defaultHeightmapSize(exp, N) {
  const list = HEIGHTMAP_SIZES[exp] || HEIGHTMAP_SIZES.generic;
  return list.reduce((a, b) => (Math.abs(b - N) < Math.abs(a - N) ? b : a));
}

// ---------- Archive d'export ----------
export async function buildGameZip(state, game, opts) {
  const T = state.terrain, name = opts.tag, n = opts.size, exp = game.exp;
  const files = {}, d = `${name}/`;
  const hm = resampleHeights(T, n);
  const range = hm.max - hm.min;
  const r2 = (v) => Math.round(v * 100) / 100;
  let how = '';

  const layers = async (flipV, label) => {
    const grid = surfaceGrid(T, n, flipV), used = usedSurfaces(T, grid), list = [];
    for (const { s, i } of used) {
      const px = new Uint8Array(n * n);
      for (let k = 0; k < px.length; k++) if (grid[k] === i) px[k] = 255;
      const fn = `${label}_${safe(s.id)}.png`;
      files[`${d}couches/${fn}`] = encodePNG(px, n, n, 1);
      list.push(`   ${fn}  ->  ${s.name}`);
    }
    return list.join('\n');
  };

  if (exp === 'roblox') {
    files[`${d}heightmap_16bit.png`] = encodePNG(heights16(hm, n), n, n, 2);
    files[`${d}heightmap_8bit.png`] = encodePNG(heights8(hm, n), n, n, 1);
    const grid = surfaceGrid(T, n), rgb = new Uint8Array(n * n * 3);
    for (let k = 0; k < grid.length; k++) { const c = (T.surfaces[grid[k]] || T.surfaces[0]).mask; rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2]; }
    files[`${d}colormap.png`] = encodePNG(rgb, n, n, 3);
    const studs = (m) => Math.round(m / 0.28);
    how = `Dans Roblox Studio :
1. Onglet Home > Editor (Terrain Editor) > Create > Import.
2. Heightmap : heightmap_16bit.png (si Studio la refuse, prends heightmap_8bit.png,
   moins précise).
3. Colormap : colormap.png. Chaque couleur correspond à un matériau Roblox
   (herbe, sable, roche...). Garde les couleurs exactes : ne retouche pas l'image
   avec un logiciel qui lisse ou compresse en JPG.
4. Size (taille en studs) : X = Z = ${studs(T.size)} et Y = ${studs(range)}
   pour garder l'échelle réelle (1 stud = 0,28 m). Roblox limite la taille d'un terrain :
   si c'est refusé, divise X, Y et Z par le même nombre.
   Pour un terrain plus petit et plus léger, 1 stud = 1 m donne X = Z = ${Math.round(T.size)}, Y = ${Math.round(range)}.
5. Position Y : mets ${studs((hm.min + hm.max) / 2)} pour que l'altitude 0 (niveau de la mer)
   reste à la hauteur 0.

Matériaux utilisés : ${usedSurfaces(T, grid).map(({ s }) => s.id).join(', ')}.
Si tu as choisi des surfaces qui ne sont pas des matériaux Roblox, Studio prendra le
matériau dont la couleur est la plus proche.`;
  } else if (exp === 'unreal') {
    files[`${d}heightmap.png`] = encodePNG(heights16(hm, n), n, n, 2);
    const list = await layers(false, 'couche');
    const xy = r2((T.size / (n - 1)) * 100), zs = r2((range * 100) / 512), zl = r2(((hm.min + hm.max) / 2) * 100);
    how = `Dans ${game.tool} :
1. Mode Landscape > Manage > New > "Import from File".
2. Heightmap File : heightmap.png (PNG 16 bits, ${n} x ${n}).
3. Scale :  X = ${xy}   Y = ${xy}   Z = ${zs}
   Location Z = ${zl}  (en cm : place l'altitude 0 de la carte à Z = 0)
   Avec ces valeurs la carte fait ${Math.round(T.size)} m de côté et le relief va de
   ${r2(hm.min)} m à ${r2(hm.max)} m.
4. Couches de peinture : crée un Landscape Material avec une couche par fichier, puis
   importe chaque image du dossier "couches" (Layer Info > Import) :
${list}
5. texture.png est une vue de dessus de la carte, utilisable comme texture globale
   ou comme repère.
${game.id === 'fortnite' ? `
Fortnite : une île UEFN a une taille maximale. Si ta carte est plus grande, réduis
X et Y (et Z dans la même proportion) pour qu'elle tienne dans l'île.
` : ''}`;
  } else if (exp === 'unity') {
    files[`${d}heightmap.raw`] = heights16(hm, n, { littleEndian: true, flipV: true });
    const list = await layers(true, 'couche');
    how = `Dans Unity :
1. GameObject > 3D Object > Terrain, puis Terrain Settings (roue dentée).
2. Mesh Resolution : Terrain Width = ${Math.round(T.size)}, Terrain Length = ${Math.round(T.size)},
   Terrain Height = ${r2(range)}.
3. Import Raw... > heightmap.raw : Depth = Bit 16, Resolution = ${n}, Byte Order = Windows.
   Ne coche pas "Flip Vertically" : le fichier est déjà dans le sens d'Unity.
4. Position Y du terrain : ${r2(hm.min)} pour que l'altitude 0 de la carte reste à Y = 0.
5. Couches (dossier "couches", même sens que le relief) : une image par surface, blanche
   là où la surface est peinte. À utiliser comme masques de Terrain Layers :
${list}
6. texture.png : vue de dessus de la carte (nord en haut).`;
  } else {
    files[`${d}heightmap_16bit.png`] = encodePNG(heights16(hm, n), n, n, 2);
    files[`${d}heightmap_16bit.raw`] = heights16(hm, n, { littleEndian: true });
    files[`${d}heightmap.asc`] = heightmapASC(T, { east: 0, north: 0 });
    const list = await layers(false, 'couche');
    how = `Fichiers de relief (au choix selon ce que ${game.tool} sait importer) :
- heightmap_16bit.png : niveaux de gris 16 bits, ${n} x ${n}, nord en haut.
  Noir = ${r2(hm.min)} m, blanc = ${r2(hm.max)} m.
- heightmap_16bit.raw : les mêmes valeurs, 16 bits non signés, petit-boutiste.
- heightmap.asc : grille ASCII (ESRI), ${T.N} x ${T.N} points, altitudes réelles en mètres.
${game.id === 'reforger' ? `
Arma Reforger (World Editor) : crée un terrain de ${Math.round(T.size)} m, puis dans l'outil Terrain
importe le relief (Import Height Map). Règle la hauteur minimale sur ${r2(hm.min)} et la
maximale sur ${r2(hm.max)}. Les images du dossier "couches" servent de masques de surface.
` : ''}
Couches de surface (dossier "couches") : une image par surface, blanche là où elle est peinte :
${list}
texture.png : vue de dessus de la carte.`;
  }

  files[`${d}texture.png`] = await canvasToPNG(satCanvas(T, 1));
  if (state.objects.objects.length) files[`${d}objets.csv`] = strToU8(objectsCSV(state));
  if (state.roads.roads.length) files[`${d}routes.json`] = strToU8(roadsJSON(state));
  files[`${d}LISEZMOI.txt`] = strToU8(`TerraForge - export pour ${game.name} (${game.tool})
${'='.repeat(40)}

Carte : ${Math.round(T.size)} m x ${Math.round(T.size)} m
Relief : de ${r2(hm.min)} m à ${r2(hm.max)} m (dénivelé ${r2(range)} m), exporté en ${n} x ${n} points
Objets : ${state.objects.objects.length}   Routes : ${state.roads.roads.length}

${how}

Autres fichiers :
- objets.csv (s'il y a des objets) : modèle, position est / nord / altitude en mètres
  (origine = coin sud-ouest de la carte), cap, tangage, roulis en degrés, échelle.
- routes.json (s'il y a des routes) : type, largeur et points [est, nord, altitude].
Ces deux fichiers ne s'importent pas tout seuls : ils servent à replacer les éléments
avec un script ou à la main.
`);
  return zipSync(files, { level: 1 });
}
