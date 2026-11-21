import { lzo1x } from './lzo.js';

// Lecteur de modèles Arma 3 binarisés (.p3d « ODOL »).
// Retourne la géométrie d'un niveau de détail visuel, prête pour Three.js.
class R {
  constructor(u8, p = 0) { this.b = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = p; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  str() { let e = this.p; while (this.b[e] !== 0) { if (++e > this.b.length) throw new Error('chaîne non terminée'); } let s = ''; for (let i = this.p; i < e; i++) s += String.fromCharCode(this.b[i]); this.p = e + 1; return s; }
  skip(n) { this.p += n; }
  // tableau compressé : n éléments de taille es
  carr(es, ver) {
    const n = this.u32();
    if (n === 0) return new Uint8Array(0);
    return this.cbytes(n * es, ver, true);
  }
  cbytes(size, ver, flagged) {
    if (size < 0 || this.p + 1 > this.b.length) throw new Error('tableau invalide');
    if (ver >= 64 && flagged) {
      const flag = this.u8();
      if (flag === 0) { const o = this.b.subarray(this.p, this.p + size); this.p += size; return o; }
      if (flag !== 2 && flag !== 1) throw new Error('drapeau de compression inconnu ' + flag);
    } else if (size < 1024) { const o = this.b.subarray(this.p, this.p + size); this.p += size; return o; }
    if (size > 512e6) throw new Error('tableau trop grand');
    const r = lzo1x(this.b, this.p, size);
    this.p = r.ip;
    return r.out;
  }
  // tableau « condensé » : soit une valeur répétée, soit un tableau compressé
  cond(es, ver, flagged = true) {
    const n = this.u32();
    const fill = this.u8();
    if (fill) { const o = this.b.subarray(this.p, this.p + es); this.p += es; return { n, fill: o }; }
    return { n, data: this.cbytes(n * es, ver, flagged) };
  }
}

function findLodTable(r, nLods, from) {
  const size = r.b.length, dv = r.dv;
  for (let p = from; p + nLods * 8 <= size; p++) {
    let ok = true;
    const starts = [], ends = [];
    for (let i = 0; i < nLods && ok; i++) {
      const s = dv.getUint32(p + i * 4, true), e = dv.getUint32(p + (nLods + i) * 4, true);
      if (s <= p + nLods * 8 || e <= s || e > size) ok = false;
      starts.push(s); ends.push(e);
    }
    if (!ok) continue;
    let linked = 0;
    for (const s of starts) if (ends.includes(s)) linked++;
    const gap = Math.min(...starts) - (p + nLods * 8);
    if (linked >= nLods - 1 && gap < 64 + nLods * 96) return { p, starts, ends };
  }
  return null;
}

function readMaterial(r) {
  const m = { name: r.str() };
  const type = r.u32();
  r.skip(4 * 4 * 6); // émissive, ambiante, diffuse, diffuse forcée, spéculaire ×2
  const dv = r.dv, q = r.p - 96;
  m.diffuse = [dv.getFloat32(q + 32, true), dv.getFloat32(q + 36, true), dv.getFloat32(q + 40, true)];
  r.f32(); // puissance spéculaire
  r.u32(); r.u32(); r.u32(); r.u32(); // pixel shader, vertex shader, lumière, brouillard
  if (type === 3) r.u8();
  if (type >= 6) m.surface = r.str();
  if (type >= 4) { const n = r.u32(); r.skip(4 * n); }
  let nStages = 0, nTexGens = 0;
  if (type > 6) nStages = r.u32();
  if (type > 8) nTexGens = r.u32();
  if (nStages > 64 || nTexGens > 64) throw new Error('matériau invalide');
  m.stages = [];
  const stage = () => {
    if (type >= 5) r.u32();
    const tex = r.str();
    const tg = type >= 8 ? r.u32() : 0;
    if (type >= 11) r.u8();
    return { tex, tg };
  };
  for (let i = 0; i < nStages; i++) m.stages.push(stage());
  m.texgens = [];
  for (let i = 0; i < nTexGens; i++) {
    const src = r.u32(); const f = [];
    for (let k = 0; k < 12; k++) f.push(r.f32());
    m.texgens.push({ src, su: f[0], sv: f[4], ou: f[9], ov: f[10] });
  }
  if (type >= 10) stage();
  return m;
}

export function p3dInfo(u8) {
  const r = new R(u8);
  const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  r.p = 4;
  if (sig === 'MLOD') throw new Error('modèle non binarisé (MLOD) : pas encore pris en charge');
  if (sig !== 'ODOL') throw new Error('ce n\'est pas un fichier .p3d');
  const ver = r.u32();
  if (ver < 50 || ver > 80) throw new Error('version ODOL ' + ver + ' non prise en charge');
  if (ver >= 59) r.u32();
  if (ver >= 58) r.str();
  const nLods = r.u32();
  if (nLods < 1 || nLods > 64) throw new Error('en-tête invalide');
  const res = [];
  for (let i = 0; i < nLods; i++) res.push(r.f32());
  const q = r.p;
  // index, 2 sphères, 3 drapeaux, centre de visée, 2 couleurs, densité
  r.skip(4 + 8 + 12 + 12 + 8 + 4);
  const v3 = () => [r.f32(), r.f32(), r.f32()];
  const bmin = v3(), bmax = v3();
  if (ver >= 70) r.f32();
  if (ver >= 71) r.f32();
  if (ver >= 52) r.skip(24);
  const center = v3();
  const table = findLodTable(r, nLods, q);
  if (!table) throw new Error('table des niveaux de détail introuvable');
  return { ver, nLods, res, bmin, bmax, center, starts: table.starts, ends: table.ends, tableAt: table.p };
}

export function readLod(u8, info, li, dbg) {
  const ver = info.ver;
  const r = new R(u8, info.starts[li]);
  const log = dbg ? (...a) => console.log('  @' + r.p, ...a) : () => {};
  const nProx = r.u32();
  if (nProx > 4096) throw new Error('LOD invalide (proxies)');
  for (let i = 0; i < nProx; i++) { r.str(); r.skip(48 + 12); if (ver >= 40) r.skip(4); }
  const nItems = r.u32(); r.skip(nItems * 4);
  const nLinks = r.u32();
  for (let i = 0; i < nLinks; i++) { const n = r.u32(); r.skip(n * 4); }
  const nVert = r.u32();
  r.f32(); r.u32(); r.u32();
  r.skip(40);
  log('nVert', nVert);
  const nTex = r.u32();
  if (nTex > 4096) throw new Error('LOD invalide (textures)');
  const textures = []; for (let i = 0; i < nTex; i++) textures.push(r.str());
  const nMat = r.u32();
  if (nMat > 4096) throw new Error('LOD invalide (matériaux)');
  const materials = []; for (let i = 0; i < nMat; i++) materials.push(readMaterial(r));
  log('tex', textures, 'mat', materials.map((m) => [m.name, m.stages.map((x) => x.tg), m.texgens]));
  const is = ver >= 69 ? 4 : 2;
  r.carr(is, ver); r.carr(is, ver); // arêtes
  const nFaces = r.u32(); const faceBytes = r.u32(); r.u16();
  log('nFaces', nFaces, faceBytes);
  if (nFaces > 4e6) throw new Error('LOD invalide (faces)');
  const faceStart = r.p;
  const faces = []; // [offset mémoire, i0..]
  let memOff = 0;
  for (let i = 0; i < nFaces; i++) {
    const off = memOff; const n = r.u8();
    memOff += is * (n + 1);
    if (n !== 3 && n !== 4) throw new Error('face invalide');
    const f = [off];
    for (let k = 0; k < n; k++) f.push(is === 4 ? r.u32() : r.u16());
    faces.push(f);
  }
  const nSec = r.u32();
  log('nSec', nSec);
  if (nSec > 4096) throw new Error('LOD invalide (sections)');
  const sections = [];
  for (let i = 0; i < nSec; i++) {
    const s = { lo: r.u32(), hi: r.u32() };
    r.u32(); r.u32(); r.u32();
    s.tex = r.dv.getInt16(r.p, true); r.p += 2;
    r.u32();
    s.mat = r.i32();
    if (s.mat === -1) r.str();
    if (ver >= 36) { const n = r.u32(); r.skip(4 * n); }
    else r.skip(4);
    if (ver >= 67) { const n = r.i32(); if (n >= 1) r.skip(44); }
    sections.push(s);
  }
  log('sections', JSON.stringify(sections));
  const nSel = r.u32();
  log('nSel', nSel);
  if (nSel > 65536) throw new Error('LOD invalide (sélections)');
  for (let i = 0; i < nSel; i++) {
    const nm = r.str();
    r.carr(is, ver);
    r.u32();
    r.u8();
    r.carr(4, ver);
    r.carr(is, ver);
    r.carr(1, ver);
    void nm;
  }
  const nTok = r.u32();
  const props = {};
  for (let i = 0; i < nTok; i++) { const k = r.str(); props[k] = r.str(); }
  log('props', props);
  const nFrames = r.u32();
  for (let i = 0; i < nFrames; i++) { r.f32(); const n = r.u32(); r.skip(12 * n); }
  r.u32(); r.u32(); r.u32();
  r.u8();
  const vtSize = r.u32();
  log('vtSize', vtSize, 'end', info.ends[li]);
  if (ver >= 50) r.cond(4, ver);
  // UV
  const readUV = () => {
    let mm = null;
    if (ver >= 45) mm = [r.f32(), r.f32(), r.f32(), r.f32()];
    const c = r.cond(ver >= 45 ? 4 : 8, ver);
    return { mm, c };
  };
  const uv0 = readUV();
  const nUV = r.u32();
  let uv1 = null;
  for (let i = 1; i < nUV; i++) { const u = readUV(); if (i === 1) uv1 = u; }
  const pts = r.carr(12, ver);
  if (dbg) console.log('normals@', r.p, [...u8.subarray(r.p, r.p + 24)].map((x) => x.toString(16)).join(' '));
  const nrm = r.cond(ver >= 45 ? 4 : 12, ver);
  log('pts', pts.length / 12, 'normals', nrm.n, 'uv', uv0.c.n);
  const n = pts.length / 12;
  const pdv = new DataView(pts.buffer, pts.byteOffset, pts.byteLength);
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const [cx, cy, cz] = info.center;
  for (let i = 0; i < n; i++) {
    positions[i * 3] = pdv.getFloat32(i * 12, true) + cx;
    positions[i * 3 + 1] = pdv.getFloat32(i * 12 + 4, true) + cy;
    positions[i * 3 + 2] = -(pdv.getFloat32(i * 12 + 8, true) + cz);
  }
  const unpackN = (v, o) => {
    const c = (x) => { x &= 0x3ff; if (x > 511) x -= 1024; return x / 511; };
    normals[o] = c(v); normals[o + 1] = c(v >> 10); normals[o + 2] = -c(v >> 20);
  };
  if (ver >= 45) {
    const src = nrm.fill || nrm.data; const ndv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (let i = 0; i < n; i++) unpackN(ndv.getUint32(nrm.fill ? 0 : i * 4, true), i * 3);
  }
  const decodeUV = (set, out) => {
    if (!set || !set.mm) return;
    const src = set.c.fill || set.c.data; const udv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const [u0, v0, u1, v1] = set.mm; const su = (u1 - u0) / 65535, sv = (v1 - v0) / 65535;
    for (let i = 0; i < n; i++) {
      const o = set.c.fill ? 0 : i * 4;
      out[i * 2] = (udv.getInt16(o, true) + 32767) * su + u0;
      out[i * 2 + 1] = (udv.getInt16(o + 2, true) + 32767) * sv + v0;
    }
  };
  decodeUV(uv0, uvs);
  let uvs1 = null;
  if (uv1 && uv1.mm && uv1.c.n === n) { uvs1 = new Float32Array(n * 2); decodeUV(uv1, uvs1); }
  // triangles regroupés par section
  const groups = [];
  const index = [];
  let fi = 0;
  for (const s of sections) {
    const start = index.length;
    while (fi < faces.length && faces[fi][0] < s.hi) {
      const f = faces[fi++];
      if (f[0] < s.lo) continue;
      // inversion de l'axe Z → on inverse le sens des faces
      index.push(f[1], f[3], f[2]);
      if (f.length === 5) index.push(f[1], f[4], f[3]);
    }
    const mat = s.mat >= 0 ? materials[s.mat] : null;
    groups.push({ start, count: index.length - start, texture: s.tex >= 0 ? textures[s.tex] : '', material: mat ? mat.name : '', diffuse: mat ? mat.diffuse : null, mat });
  }
  for (const v of index) if (v >= n) throw new Error('indice de sommet hors limites');
  return { positions, normals, uvs, uvs1, index: n > 65535 ? new Uint32Array(index) : new Uint16Array(index), groups, nFaces, props };
}

// Choisit un niveau de détail visuel raisonnable et le lit.
export function parseP3D(u8, { maxFaces = 12000 } = {}) {
  const info = p3dInfo(u8);
  const visual = [];
  for (let i = 0; i < info.nLods; i++) if (info.res[i] < 900) visual.push(i);
  if (!visual.length) throw new Error('aucun niveau de détail visuel');
  let lastErr = null, best = null;
  for (const li of visual) {
    try {
      const lod = readLod(u8, info, li);
      if (!lod.index.length) continue;
      best = lod;
      if (lod.nFaces <= maxFaces) break;
    } catch (e) { lastErr = e; if (best) break; }
  }
  if (!best) throw lastErr || new Error('modèle vide');
  best.info = info;
  return best;
}
