import { zipSync, strToU8 } from 'fflate';

// Décalage de la grille Terrain Builder (Mapframe : easting par défaut 200000).
export const DEFAULT_OFFSET = { east: 200000, north: 0 };

const fmt = (v, d = 3) => Number(v.toFixed(d)).toString();

// ---------- Relief ----------
export function heightmapASC(T, off = DEFAULT_OFFSET) {
  const N = T.N;
  const lines = [
    `ncols         ${N}`,
    `nrows         ${N}`,
    `xllcorner     ${off.east}`,
    `yllcorner     ${off.north}`,
    `cellsize      ${T.cell}`,
    `NODATA_value  -9999`,
  ];
  for (let j = 0; j < N; j++) {
    const row = new Array(N);
    for (let i = 0; i < N; i++) row[i] = fmt(T.heights[j * N + i], 2);
    lines.push(row.join(' '));
  }
  return lines.join('\n') + '\n';
}

export function heightmapXYZ(T, off = DEFAULT_OFFSET) {
  const N = T.N, out = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++)
      out.push(`${fmt(off.east + i * T.cell, 2)} ${fmt(off.north + T.size - j * T.cell, 2)} ${fmt(T.heights[j * N + i], 2)}`);
  return out.join('\n') + '\n';
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

export function maskCanvas(T, scale = 1) {
  const R = T.maskRes, S = R * scale;
  const c = canvasOf(S, S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S), D = img.data;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const s = T.surfaces[T.surf[Math.floor(y / scale) * R + Math.floor(x / scale)]] || T.surfaces[0];
      const k = (y * S + x) * 4;
      D[k] = s.mask[0]; D[k + 1] = s.mask[1]; D[k + 2] = s.mask[2]; D[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Image satellite : couleurs de surface + ombrage du relief.
export function satCanvas(T, scale = 1) {
  const R = T.maskRes, S = R * scale;
  const c = canvasOf(S, S), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(T.canvas, 0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S), D = img.data;
  const L = [-0.5, 0.75, -0.45];
  const ll = Math.hypot(...L);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const wx = (x / (S - 1)) * T.size, wz = (y / (S - 1)) * T.size;
      const c2 = T.cell;
      const nx = T.heightAt(wx - c2, wz) - T.heightAt(wx + c2, wz);
      const nz = T.heightAt(wx, wz - c2) - T.heightAt(wx, wz + c2);
      const ny = 2 * c2;
      const nl = Math.hypot(nx, ny, nz);
      const shade = 0.55 + 0.6 * Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / (nl * ll));
      const k = (y * S + x) * 4;
      D[k] = Math.min(255, D[k] * shade);
      D[k + 1] = Math.min(255, D[k + 1] * shade);
      D[k + 2] = Math.min(255, D[k + 2] * shade);
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasToPNG(c) {
  return new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
}

export function layersCfg(surfaces, tag) {
  let s = '// Généré par TerraForge A3. Remplace les chemins .rvmat par ceux de ton mod.\nclass Layers\n{\n';
  for (const su of surfaces)
    s += `\tclass ${su.id}\n\t{\n\t\ttexture = "";\n\t\tmaterial = "${tag}\\data\\gdt_${su.id}.rvmat";\n\t};\n`;
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
    const east = off.east + o.x, north = off.north + T.size - o.z;
    let yaw = (-o.rot * 180) / Math.PI;
    yaw = ((yaw % 360) + 360) % 360;
    out.push(`"${names.get(o.lib)}";${fmt(east)};${fmt(north)};${fmt(yaw, 2)};0;0;${fmt(o.scale, 3)};${fmt(o.dy || 0, 3)};`);
  }
  return out.join('\r\n') + '\r\n';
}

// ---------- Routes : shapefile (polylignes) ----------
export function roadsShapefile(roads, roadMgr, T, off = DEFAULT_OFFSET) {
  const recs = roads.filter((r) => r.points.length >= 2).map((r) => {
    const pts = roadMgr.sample(r, 5).map((p) => [off.east + p.x, off.north + T.size - p.z]);
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
  let s = '// Généré par TerraForge A3. Adapte les textures/matériaux à ton mod.\nclass RoadTypesLibrary\n{\n';
  for (const t of types) {
    const n = String(t.id).padStart(4, '0');
    s += `\tclass Road${n}\n\t{\n\t\twidth = ${t.width};\n\t\tmainStrTex = "${tag}\\data\\roads\\road${n}_co.paa";\n\t\tmainTerTex = "${tag}\\data\\roads\\road${n}_end_co.paa";\n\t\tmainMat = "${tag}\\data\\roads\\road${n}.rvmat";\n\t\tmap = "${t.map}";\n\t\tAIpathOffset = ${Math.max(1, Math.round(t.width / 4))};\n\t\torder = ${t.id};\n\t};\n`;
  }
  return s + '};\n';
}

// ---------- Paquet complet ----------
export async function buildExportZip(state, opts) {
  const { terrain: T, objects: O, roads: R } = state;
  const tag = opts.tag || 'monterrain';
  const off = { east: opts.offsetEast ?? 200000, north: opts.offsetNorth ?? 0 };
  const files = {};
  files['heightmap.asc'] = strToU8(heightmapASC(T, off));
  if (opts.xyz) files['heightmap.xyz'] = strToU8(heightmapXYZ(T, off));
  files['mask/mask.png'] = await canvasToPNG(maskCanvas(T, opts.imageScale || 1));
  files['mask/layers.cfg'] = strToU8(layersCfg(T.surfaces, tag));
  files['sat/sat.png'] = await canvasToPNG(satCanvas(T, opts.imageScale || 1));
  files['objets/objets_terrain_builder.txt'] = strToU8(objectsTXT(O.objects, O.library, T, off));
  const shp = roadsShapefile(R.roads, R, T, off);
  files['routes/roads.shp'] = shp.shp;
  files['routes/roads.shx'] = shp.shx;
  files['routes/roads.dbf'] = shp.dbf;
  files['routes/RoadsLib.cfg'] = strToU8(roadsLibCfg(R.types, tag));
  files['LISEZMOI.txt'] = strToU8(readme(T, off, opts, O.objects.length, R.roads.length));
  return zipSync(files, { level: 6 });
}

function readme(T, off, opts, nObj, nRoads) {
  const px = T.maskRes * (opts.imageScale || 1);
  return `TerraForge A3 - export pour Terrain Builder
==========================================

Taille du terrain : ${T.size} m x ${T.size} m
Grille d'altitude : ${T.N} x ${T.N} points, ${T.cell} m par cellule
Images sat/mask   : ${px} x ${px} px (${(T.size / px).toFixed(2)} m/px)
Décalage (Mapframe) : Easting ${off.east}, Northing ${off.north}
Objets : ${nObj}   Routes : ${nRoads}

Dans Terrain Builder :
1. Mapframe > Properties : mêmes valeurs de taille de grille, de cellule et d'image
   que ci-dessus, Easting ${off.east}, Northing ${off.north}.
2. Heightfield : File > Import > Terrain... > heightmap.asc
3. Mapframe > Properties > Processing : sat/sat.png en image satellite,
   mask/mask.png en masque de surface, mask/layers.cfg comme configuration des couches.
   Puis "Generate layers".
4. Objets : chaque nom de objets_terrain_builder.txt doit exister dans ta bibliothèque TB
   (Templates Library). Puis File > Import > Objects... (format texte
   Name;X;Y;Yaw;Pitch;Roll;Scale;Z).
5. Routes : Vector layer > Import shapefile > routes/roads.shp. Le champ ID renvoie
   aux classes RoadXXXX de routes/RoadsLib.cfg à placer dans ton dossier de routes.
6. Exporte le WRP depuis Terrain Builder puis pack avec Addon Builder / pboProject.

Mer : Arma 3 place le niveau de la mer à 0 m. Tout ce qui est sous 0 m sera de l'eau.
`;
}
