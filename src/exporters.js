import { zipSync, strToU8 } from 'fflate';

// Décalage de la grille Terrain Builder (Mapframe : easting par défaut 200000).
export const DEFAULT_OFFSET = { east: 200000, north: 0 };

const fmt = (v, d = 3) => Number(v.toFixed(d)).toString();

// ---------- Relief ----------
// Renvoie des octets (les grandes grilles dépassent la taille maximale d'une chaîne).
export function heightmapASC(T, off = DEFAULT_OFFSET) {
  const N = T.N, enc = new TextEncoder();
  const chunks = [enc.encode([
    `ncols         ${N}`,
    `nrows         ${N}`,
    `xllcorner     ${off.east}`,
    `yllcorner     ${off.north}`,
    `cellsize      ${T.cell}`,
    `NODATA_value  -9999`,
  ].join('\n') + '\n')];
  const row = new Array(N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) row[i] = T.heights[j * N + i].toFixed(2);
    chunks.push(enc.encode(row.join(' ') + '\n'));
  }
  return concat(chunks);
}

export function heightmapXYZ(T, off = DEFAULT_OFFSET) {
  const N = T.N, enc = new TextEncoder(), chunks = [];
  const row = new Array(N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++)
      row[i] = `${fmt(off.east + i * T.cell, 2)} ${fmt(off.north + T.north(j * T.cell), 2)} ${T.heights[j * N + i].toFixed(2)}`;
    chunks.push(enc.encode(row.join('\n') + '\n'));
  }
  return concat(chunks);
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function parseASC(text) {
  const lines = text.split(/\r?\n/);
  const head = {};
  let k = 0;
  for (; k < lines.length; k++) {
    const m = lines[k].trim().match(/^([a-zA-Z_]+)\s+(-?[\d.eE+-]+)$/);
    if (!m) break;
    head[m[1].toLowerCase()] = parseFloat(m[2]);
  }
  const w = head.ncols, h = head.nrows;
  const vals = lines.slice(k).join(' ').trim().split(/\s+/).map(Number);
  const nod = head.nodata_value ?? -9999;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = vals[i] === nod || !isFinite(vals[i]) ? 0 : vals[i];
  return { data, w, h, cellsize: head.cellsize };
}

// ---------- Images ----------
function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function scaled(src, scale, smooth) {
  if (scale === 1) return src;
  const c = canvasOf(Math.round(src.width * scale), Math.round(src.height * scale)), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function maskCanvas(T, scale = 1) {
  const R = T.maskRes;
  const c = canvasOf(R, R), ctx = c.getContext('2d');
  const img = ctx.createImageData(R, R), D = img.data;
  for (let k = 0; k < R * R; k++) {
    const s = T.surfaces[T.surf[k]] || T.surfaces[0];
    D[k * 4] = s.mask[0]; D[k * 4 + 1] = s.mask[1]; D[k * 4 + 2] = s.mask[2]; D[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return scaled(c, scale, false); // sans lissage : les couleurs du masque restent exactes
}

// Image satellite : couleurs de surface + ombrage du relief.
export function satCanvas(T, scale = 1) {
  if (T.sat) return scaled(T.sat, (T.maskRes * scale) / T.sat.width, true); // image réelle importée
  const R = T.maskRes;
  const c = canvasOf(R, R), ctx = c.getContext('2d');
  ctx.drawImage(T.canvas, 0, 0);
  const img = ctx.getImageData(0, 0, R, R), D = img.data;
  const L = [-0.5, 0.75, -0.45];
  const ll = Math.hypot(...L);
  const c2 = Math.max(T.cell, T.size / R);
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const [wx, wz] = T.maskToWorld(x, y);
      const nx = T.heightAt(wx - c2, wz) - T.heightAt(wx + c2, wz);
      const nz = T.heightAt(wx, wz - c2) - T.heightAt(wx, wz + c2);
      const ny = 2 * c2;
      const nl = Math.hypot(nx, ny, nz);
      const shade = 0.55 + 0.6 * Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / (nl * ll));
      const k = (y * R + x) * 4;
      D[k] = Math.min(255, D[k] * shade);
      D[k + 1] = Math.min(255, D[k + 1] * shade);
      D[k + 2] = Math.min(255, D[k + 2] * shade);
    }
  ctx.putImageData(img, 0, 0);
  return scaled(c, scale, true);
}

export function canvasToJPEG(c) {
  return new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.92));
}

export function canvasToPNG(c) {
  return new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
}

export function layersCfg(surfaces, tag) {
  let s = '// Généré par TerraForge. Remplace les chemins .rvmat par ceux de ton mod.\nclass Layers\n{\n';
  for (const su of surfaces)
    s += `\tclass ${su.id}\n\t{\n\t\ttexture = "";\n\t\tmaterial = "${su.rvmat || `${tag}\\data\\${su.id}.rvmat`}";\n\t};\n`;
  s += '};\n\nclass Legend\n{\n\tpicture = "' + tag + '\\source\\mapLegend.png";\n\tclass Colors\n\t{\n';
  for (const su of surfaces) s += `\t\t${su.id}[] = {{${su.mask.join(',')}}};\n`;
  s += '\t};\n};\n';
  return s;
}

// ---------- Objets ----------
// Format texte d'import Terrain Builder :
// "NomModèle";X;Y;Yaw;Pitch;Roll;Scale;Z;
export function objectsTXT(objects, library, T, off = DEFAULT_OFFSET) {
  const names = new Map(library.map((e) => [e.id, e.tbName || e.name]));
  const out = [];
  for (const o of objects) {
    const east = off.east + o.x, north = off.north + T.north(o.z);
    let yaw = (-o.rot * 180) / Math.PI;
    yaw = ((yaw % 360) + 360) % 360;
    out.push(`"${names.get(o.lib)}";${fmt(east)};${fmt(north)};${fmt(yaw, 2)};0;0;${fmt(o.scale, 3)};${fmt(o.dy || 0, 3)};`);
  }
  return out.join('\r\n') + '\r\n';
}

// ---------- Routes : shapefile (polylignes) ----------
export function roadsShapefile(roads, roadMgr, T, off = DEFAULT_OFFSET) {
  const recs = roads.filter((r) => r.points.length >= 2).map((r) => {
    const pts = roadMgr.sample(r, 5).map((p) => [off.east + p.x, off.north + T.north(p.z)]);
    return { id: r.type, pts };
  });
  const bboxOf = (pts) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    return [a, b, c, d];
  };
  const all = recs.flatMap((r) => r.pts);
  const bbox = all.length ? bboxOf(all) : [0, 0, 0, 0];

  const contentLen = (r) => 44 + 4 + 16 * r.pts.length;
  const shpLen = 100 + recs.reduce((s, r) => s + 8 + contentLen(r), 0);
  const shp = new DataView(new ArrayBuffer(shpLen));
  const shx = new DataView(new ArrayBuffer(100 + 8 * recs.length));
  const header = (dv, lenBytes) => {
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, lenBytes / 2, false);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, 3, true);
    bbox.forEach((v, k) => dv.setFloat64(36 + k * 8, v, true));
  };
  header(shp, shpLen);
  header(shx, 100 + 8 * recs.length);
  let o = 100;
  recs.forEach((r, n) => {
    const cl = contentLen(r);
    shx.setInt32(100 + n * 8, o / 2, false);
    shx.setInt32(104 + n * 8, cl / 2, false);
    shp.setInt32(o, n + 1, false); shp.setInt32(o + 4, cl / 2, false);
    let p = o + 8;
    shp.setInt32(p, 3, true); p += 4;
    bboxOf(r.pts).forEach((v) => { shp.setFloat64(p, v, true); p += 8; });
    shp.setInt32(p, 1, true); shp.setInt32(p + 4, r.pts.length, true); shp.setInt32(p + 8, 0, true); p += 12;
    for (const [x, y] of r.pts) { shp.setFloat64(p, x, true); shp.setFloat64(p + 8, y, true); p += 16; }
    o += 8 + cl;
  });

  // DBF avec un champ numérique ID.
  const fieldLen = 10;
  const recLen = 1 + fieldLen;
  const headLen = 32 + 32 + 1;
  const dbf = new Uint8Array(headLen + recLen * recs.length + 1);
  const dv = new DataView(dbf.buffer);
  const now = new Date();
  dbf[0] = 3; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
  dv.setUint32(4, recs.length, true);
  dv.setUint16(8, headLen, true);
  dv.setUint16(10, recLen, true);
  dbf.set(strToU8('ID'), 32);
  dbf[32 + 11] = 'N'.charCodeAt(0);
  dbf[32 + 16] = fieldLen; dbf[32 + 17] = 0;
  dbf[64] = 0x0d;
  recs.forEach((r, n) => {
    const base = headLen + n * recLen;
    dbf[base] = 0x20;
    dbf.set(strToU8(String(r.id).padStart(fieldLen, ' ')), base + 1);
  });
  dbf[dbf.length - 1] = 0x1a;
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer), dbf };
}

export function roadsLibCfg(types, tag) {
  let s = '// Généré par TerraForge. Adapte les textures/matériaux à ton mod.\nclass RoadTypesLibrary\n{\n';
  for (const t of types) {
    const n = String(t.id).padStart(4, '0');
    const str = t.tex || `${tag}\\data\\roads\\road${n}_co.paa`;
    const ter = t.tex ? t.tex.replace(/_(ca|co)\.paa$/i, '_end_$1.paa') : `${tag}\\data\\roads\\road${n}_end_co.paa`;
    const mat = t.tex ? t.tex.replace(/_(ca|co)\.paa$/i, '.rvmat') : `${tag}\\data\\roads\\road${n}.rvmat`;
    s += `\tclass Road${n}\n\t{\n\t\twidth = ${t.width};\n\t\tmainStrTex = "${str}";\n\t\tmainTerTex = "${ter}";\n\t\tmainMat = "${mat}";\n\t\tmap = "${t.map}";\n\t\tAIpathOffset = ${Math.max(1, Math.round(t.width / 4))};\n\t\torder = ${t.id};\n\t};\n`;
  }
  return s + '};\n';
}

// ---------- config.cpp ----------
export function configCpp(name, T, author, geo) {
  const half = Math.round(T.size / 2);
  return `// Généré par TerraForge : base de configuration à compléter.
class CfgPatches
{
	class ${name}
	{
		units[] = {};
		weapons[] = {};
		requiredVersion = 1.0;
		requiredAddons[] = {"A3_Map_Stratis"};
		author = "${author || ''}";
	};
};

class CfgWorldList
{
	class ${name} {};
};

class CfgWorlds
{
	class Stratis;
	class ${name}: Stratis
	{
		description = "${name}";
		author = "${author || ''}";
		worldName = "\\${name}\\${name}.wrp";
		pictureMap = "";
		pictureShot = "";
		mapSize = ${T.size};
		mapZone = 35;
		longitude = ${geo ? geo.lon.toFixed(3) : 25};
		latitude = ${geo ? (-geo.lat).toFixed(3) : -40}; // négatif = hémisphère nord
		elevationOffset = 0;
		startTime = "12:00";
		startDate = "15/6/2035";
		centerPosition[] = {${half}, ${half}, 300};
		ilsPosition[] = {0, 0};
		ilsDirection[] = {0, 0, 0};
		ilsTaxiIn[] = {};
		ilsTaxiOff[] = {};
		class SecondaryAirports {};
		class Names {};
	};
};
`;
}

// ---------- Paquet complet : dossier du mod ----------
export async function buildExportZip(state, opts) {
  const { terrain: T, objects: O, roads: R } = state;
  const name = opts.tag || 'MonTerrain';
  // Sat et masque doivent avoir la même taille : on s'aligne sur l'image réelle si elle est plus fine.
  if (T.sat) opts = { ...opts, imageScale: Math.max(opts.imageScale || 1, Math.min(8, Math.ceil(T.sat.width / T.maskRes))) };
  const off = { east: opts.offsetEast ?? 200000, north: opts.offsetNorth ?? 0 };
  const files = {};
  const src = `${name}/source/`;
  files[`${name}/config.cpp`] = strToU8(configCpp(name, T, opts.author, opts.geo));
  files[`${src}${name}.asc`] = heightmapASC(T, off);
  if (opts.xyz) files[`${src}${name}.xyz`] = heightmapXYZ(T, off);
  files[`${src}${name}_mask.png`] = await canvasToPNG(maskCanvas(T, opts.imageScale || 1));
  files[`${src}layers.cfg`] = strToU8(layersCfg(T.surfaces, name));
  files[`${src}${name}_sat.png`] = await canvasToPNG(satCanvas(T, opts.imageScale || 1));
  files[`${src}${name}_objets.txt`] = strToU8(objectsTXT(O.objects, O.library, T, off));
  const shp = roadsShapefile(R.roads, R, T, off);
  files[`${name}/data/roads/roads.shp`] = shp.shp;
  files[`${name}/data/roads/roads.shx`] = shp.shx;
  files[`${name}/data/roads/roads.dbf`] = shp.dbf;
  files[`${name}/data/roads/RoadsLib.cfg`] = strToU8(roadsLibCfg(R.types, name));
  files[`${name}/LISEZMOI.txt`] = strToU8(readme(name, T, off, opts, O.objects.length, R.roads.length));
  // Les PNG sont déjà compressés ; niveau faible pour rester rapide sur les grandes cartes.
  return zipSync(files, { level: 3 });
}

function readme(name, T, off, opts, nObj, nRoads) {
  const px = T.maskRes * (opts.imageScale || 1);
  return `TerraForge - export pour Terrain Builder
==========================================

Décompresse le dossier "${name}" à la racine de ton lecteur P:  (P:\\${name}).

Taille du terrain : ${T.size} m x ${T.size} m
Grille d'altitude : ${T.N} x ${T.N} points, ${T.cell} m par cellule
Images sat/mask   : ${px} x ${px} px (${(T.size / px).toFixed(2)} m/px)
Décalage (Mapframe) : Easting ${off.east}, Northing ${off.north}
Objets : ${nObj}   Routes : ${nRoads}

Dans Terrain Builder :
1. Mapframe > Properties : grille ${T.N} x ${T.N}, cellule ${T.cell} m, image ${px} px,
   Easting ${off.east}, Northing ${off.north}.
2. Relief : File > Import > Terrain... > source\\${name}.asc
3. Mapframe > Properties > Processing : source\\${name}_sat.png en image satellite,
   source\\${name}_mask.png en masque de surface, source\\layers.cfg pour les couches.
   Puis "Generate layers".
4. Objets : chaque nom de source\\${name}_objets.txt doit exister dans ta bibliothèque TB
   (Templates Library). Puis File > Import > Objects... (format texte
   Name;X;Y;Yaw;Pitch;Roll;Scale;Z).
5. Routes : data\\roads\\roads.shp (polylignes, champ ID) et RoadsLib.cfg.
   Remplace les textures de RoadsLib.cfg par celles de ton mod ou d'Arma 3.
6. Exporte le WRP dans P:\\${name}\\${name}.wrp, puis pack le dossier avec
   Addon Builder ou pboProject.

config.cpp est une base minimale (hérite de Stratis) : complète-la
(noms de lieux, éclairage, etc.) avant de publier.
Les chemins .rvmat de layers.cfg pour le jeu "Altis / Stratis" pointent vers
a3\\map_data : vérifie-les dans ton lecteur P: avant de générer les couches.

${opts.geo ? `Données réelles à créditer si tu publies la map :
- Routes, bâtiments, occupation du sol : (c) contributeurs OpenStreetMap (ODbL)
- Relief : Mapzen / AWS Terrain Tiles
${opts.satCredit ? '- Image satellite : ' + opts.satCredit + '\n' : ''}
` : ''}Mer : Arma 3 place le niveau de la mer à 0 m. Tout ce qui est sous 0 m sera de l'eau.
`;
}
