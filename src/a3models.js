import * as THREE from 'three';
import { parseP3D } from './p3d.js';

// Transforme un .p3d de la source Arma 3 en « parts » affichables (géométrie + matériau).
const texCache = new Map(); // key|taille -> Promise<{tex, alpha}|null>

function procColor(s) {
  const m = /color\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/i.exec(s);
  return m ? new THREE.Color(+m[1], +m[2], +m[3]) : null;
}

function loadTexture(src, path, maxSize) {
  const key = src.resolve(path);
  if (!key) return Promise.resolve(null);
  const ck = key + '|' + maxSize;
  if (!texCache.has(ck)) {
    texCache.set(ck, src.image(path, maxSize).then((img) => {
      if (!img) return null;
      const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      tex.userData.ck = ck;
      return { tex, alpha: img.hasAlpha };
    }));
  }
  return texCache.get(ck);
}

export async function loadP3DParts(src, key, { maxFaces = 4000, texSize = 512 } = {}) {
  const u8 = await src.read(key);
  const lod = parseP3D(u8, { maxFaces });
  const pos = new THREE.BufferAttribute(lod.positions, 3);
  const nrm = new THREE.BufferAttribute(lod.normals, 3);
  const uv = new THREE.BufferAttribute(lod.uvs, 2);
  // regroupe les sections par texture
  const byTex = new Map();
  for (const g of lod.groups) {
    if (!g.count) continue;
    const k = g.texture || ('#' + (g.diffuse || []).join(','));
    let e = byTex.get(k);
    if (!e) byTex.set(k, (e = { texture: g.texture, diffuse: g.diffuse, ranges: [] }));
    e.ranges.push(g);
  }
  const parts = [];
  for (const e of byTex.values()) {
    let n = 0;
    for (const r of e.ranges) n += r.count;
    const idx = new (lod.index.constructor)(n);
    let o = 0;
    for (const r of e.ranges) { idx.set(lod.index.subarray(r.start, r.start + r.count), o); o += r.count; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', pos);
    geometry.setAttribute('normal', nrm);
    geometry.setAttribute('uv', uv);
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    const material = new THREE.MeshStandardMaterial({ color: '#b9b4aa', roughness: 0.9, metalness: 0 });
    const pc = e.texture && e.texture.startsWith('#') ? procColor(e.texture) : null;
    if (pc) material.color.copy(pc);
    else if (e.texture) {
      const t = await loadTexture(src, e.texture, texSize);
      if (t) {
        material.map = t.tex;
        material.color.set('#ffffff');
        if (t.alpha && /_ca\.paa$/i.test(e.texture)) { material.alphaTest = 0.45; material.side = THREE.DoubleSide; material.color.setScalar(1.5); }
      } else if (/_ca\.paa$/i.test(e.texture)) material.color.set('#55703a');
    } else if (e.diffuse && e.diffuse.some((v) => v > 0)) material.color.setRGB(...e.diffuse.map((v) => Math.min(1, v)));
    parts.push({ geometry, material, matrix: new THREE.Matrix4() });
  }
  let maxY = 0;
  for (let i = 1; i < lod.positions.length; i += 3) if (lod.positions[i] > maxY) maxY = lod.positions[i];
  return { parts, height: maxY || 1, faces: lod.index.length / 3 };
}

export function guessCategory(key) {
  const base = key.slice(key.lastIndexOf('\\') + 1);
  if (/^t_/.test(base)) return 'Arbres';
  if (/^b_/.test(base)) return 'Buissons';
  if (/\\rocks|stone|rock/.test(key)) return 'Rochers';
  if (/\\walls\\|wall|fence/.test(key)) return 'Murs et clôtures';
  if (/structures|house|building/.test(key)) return 'Bâtiments';
  return 'Divers';
}

// Libère un modèle chargé juste pour une vignette (géométries, matériaux, textures).
export function disposeParts(parts) {
  for (const p of parts) {
    p.geometry.dispose();
    const t = p.material.map;
    if (t) { texCache.delete(t.userData.ck); t.dispose(); }
    p.material.dispose();
  }
}
