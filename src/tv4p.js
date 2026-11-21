// Lecture des projets Terrain Builder (.tv4p, format binaire "ALB1").
// Le fichier est un arbre : chaque champ = étiquette (u16) + type (u8) + valeur.

export function parseALB1(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'ALB1') throw new Error("ce n'est pas un fichier Terrain Builder (signature ALB1 absente)");
  let p = 16;
  const td = new TextDecoder('windows-1252');
  const str = (n) => { const s = td.decode(u8.subarray(p, p + n)); p += n; return s; };
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const table = () => {
    p += 3; // étiquette + type
    const n = u32(), out = {};
    for (let i = 0; i < n; i++) { const k = u16(), l = u16(); out[k] = str(l); }
    return out;
  };
  const tags = table(), classes = table();
  const warnings = [];

  function value(ty) {
    switch (ty) {
      case 0x01: return u8[p++];
      case 0x05: { const v = dv.getInt32(p, true); p += 4; return v; }
      case 0x06: case 0x07: return u32();
      case 0x08: return false;
      case 0x09: return !!u8[p++];
      case 0x0a: { const v = dv.getFloat32(p, true); p += 4; return v; }
      case 0x14: { const v = dv.getFloat64(p, true); p += 8; return v; }
      case 0x0b: return str(u16());
      case 0x13: return null;
      case 0x0e: { const c = u16(); return { _ref: classes[c] || c, _ptr: u32() }; }
      case 0x15: { const n = u8[p++], a = []; for (let i = 0; i < n; i++) { a.push(dv.getFloat64(p, true)); p += 8; } return a; }
      case 0x0f: { const k = field(), v = field(); return [k[1], v[1]]; }
      case 0x0d: {
        const size = u32(), end = p + size;
        const o = { _class: classes[u16()] || '?' };
        p += 4;
        fields(o, end);
        return o;
      }
      case 0x0c: {
        const size = u32(), end = p + size;
        p += 4; // nombre d'éléments
        const a = [];
        try { while (p < end) a.push(field()[1]); } catch (e) { warnings.push(e.message); }
        p = end;
        return a;
      }
      default: throw new Error(`type de champ inconnu 0x${ty.toString(16)} à l'octet ${p - 1}`);
    }
  }
  function field() {
    const t = u16(), ty = u8[p++];
    return [tags[t] || 'tag' + t, value(ty)];
  }
  function fields(o, end) {
    try { while (p < end) { const [k, v] = field(); o[k] = v; } } catch (e) { warnings.push(e.message); }
    p = end;
  }
  const root = { _class: classes[u16()] || '?' };
  p += 4;
  fields(root, u8.length);
  return { root, warnings };
}

const KIND = { 0: 'relief', 1: 'sat', 2: 'mask' };
export const baseName = (path) => String(path).split(/[\\/]/).pop().toLowerCase();

// Extrait d'un .tv4p ce dont TerraForge a besoin.
export function readTv4p(u8) {
  const { root, warnings } = parseALB1(u8);
  if (root._class !== 'CVisitor4Project') throw new Error('ce fichier ALB1 n\'est pas un projet Terrain Builder (.tv4p)');
  const om = root.objManager || {};
  const mf = om.mapFrame || {};
  const frames = (mf.mframe || []).map((f) => {
    const c = f.config || {}, pos = f.mpos || [];
    const width = pos.length === 4 ? Math.abs(pos[2] - pos[0]) : 0;
    const grid = f.size || 0;
    return {
      name: f.name || '', grid, width,
      cell: grid && width ? width / grid : 0,
      east: pos.length === 4 ? Math.min(pos[0], pos[2]) : 200000,
      north: pos.length === 4 ? Math.min(pos[1], pos[3]) : 0,
      layersCfg: c.wrpfilecfg || '', exportDir: c.wrpdirexport || '',
      imagery: c.imageryWidth || 0, imageryRes: c.imageryResolution || 0,
    };
  });
  const frame = frames[mf.mselected || 0] || frames[0] || null;
  const contents = [];
  for (const pair of root.world?.mcontents?.mcontents || []) {
    const c = pair && pair[1];
    if (!c || !c.filename) continue; // contenus internes (cache du relief)
    contents.push({ kind: KIND[c.type] || 'autre', path: c.filename, file: baseName(c.filename), order: c.mlayerIndex || 0, visible: c.misVisible !== false });
  }
  return {
    name: root.mname || frame?.name || 'terrain',
    frame, frames, contents,
    models: (om.mobjectsDelta || []).map((x) => x && x[0]).filter((x) => typeof x === 'string'),
    libs: root.libs || [],
    objectCount: om.mlTotalObjectCount || 0,
    warnings,
  };
}

// layers.cfg -> [{ id, rvmat, colors: [[r,g,b], …] }]
export function parseLayersCfg(text) {
  text = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  const get = (id) => { const k = id.toLowerCase(); if (!out.has(k)) out.set(k, { id, rvmat: '', colors: [] }); return out.get(k); };
  for (const m of text.matchAll(/class\s+(\w+)\s*\{([^{}]*)\}/g)) {
    const mat = m[2].match(/material\s*=\s*"([^"]*)"/i);
    if (mat) get(m[1]).rvmat = mat[1];
  }
  for (const m of text.matchAll(/(\w+)\s*\[\s*\]\s*=\s*\{\s*((?:\{[^{}]*\}\s*,?\s*)+)\}/g))
    for (const c of m[2].matchAll(/\{([^{}]*)\}/g)) {
      const rgb = c[1].split(',').map((v) => parseInt(v, 10));
      if (rgb.length >= 3 && rgb.every((v) => v >= 0 && v <= 255)) get(m[1]).colors.push(rgb.slice(0, 3));
    }
  return [...out.values()].filter((l) => l.colors.length);
}

// Lecture d'un relief ASC en flux : ces fichiers pèsent souvent plus de 100 Mo,
// trop pour être chargés d'un bloc sous forme de texte.
export async function readASCFile(file, progress) {
  const CH = 8 << 20;
  const head = {};
  let data = null, n = 0, total = 0, nod = -9999;
  let tok = '', key = null, inHead = true;
  const number = (s) => {
    const v = +s;
    if (n < total) data[n++] = v === nod || !isFinite(v) ? 0 : v;
  };
  const token = (s) => {
    if (inHead) {
      if (key) { head[key] = parseFloat(s); key = null; return; }
      if (/^[a-zA-Z_]+$/.test(s)) { key = s.toLowerCase(); return; }
      inHead = false;
      if (!(head.ncols > 0 && head.nrows > 0)) throw new Error('en-tête ASC invalide (ncols / nrows absents)');
      total = head.ncols * head.nrows;
      if (total > 9000 * 9000) throw new Error(`relief trop grand (${head.ncols} × ${head.nrows})`);
      data = new Float32Array(total);
      nod = head.nodata_value ?? -9999;
    }
    number(s);
  };
  for (let off = 0; off < file.size; off += CH) {
    const b = new Uint8Array(await file.slice(off, off + CH).arrayBuffer());
    let start = -1;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        if (start >= 0) { tok += String.fromCharCode.apply(null, b.subarray(start, i)); start = -1; }
        if (tok) { token(tok); tok = ''; }
      } else if (start < 0) start = i;
    }
    if (start >= 0) tok += String.fromCharCode.apply(null, b.subarray(start));
    if (progress) progress(Math.min(1, (off + CH) / file.size));
    if (!inHead && n >= total) break;
  }
  if (tok) token(tok);
  if (!data) throw new Error('fichier ASC vide');
  return { data, w: head.ncols, h: head.nrows, cellsize: head.cellsize, filled: n };
}
