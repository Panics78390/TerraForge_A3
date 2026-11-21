import * as THREE from 'three';
import { parseP3D } from './p3d.js';

// Transforme un .p3d de la source Arma 3 en « parts » affichables (géométrie + matériau).
const texCache = new Map(); // key|taille -> Promise<{tex, alpha}|null>

function procColor(s) {
  const m = /color\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/i.exec(s);
  return m ? new THREE.Color(+m[1], +m[2], +m[3]) : null;
}

export function loadTexture(src, path, maxSize, linear = false) {
  const key = src.resolve(path);
  if (!key) return Promise.resolve(null);
  const ck = key + '|' + maxSize + (linear ? '|l' : '');
  if (!texCache.has(ck)) {
    texCache.set(ck, src.image(path, maxSize).then((img) => {
      if (!img) return null;
      const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
      tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
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

const isCo = (t) => /_(co|ca)\.paa$/i.test(t || '');

// Sections sans texture directe : on lit les textures déclarées dans le matériau.
// « Multi-matériau » des bâtiments : 4 textures de couleur mélangées par un masque (2e jeu d'UV).
async function applyMaterialStages(src, mat, material, texSize, hasUv1) {
  const st = (mat.stages || []).map((x) => x.tex);
  const multi = st.length >= 5 && st.slice(0, 4).every(isCo) && /\.paa$/i.test(st[4]) && !isCo(st[4]);
  if (multi) {
    const [a, b, c, d, mask] = await Promise.all([
      ...st.slice(0, 4).map((t) => loadTexture(src, t, texSize)),
      loadTexture(src, st[4], texSize, true),
    ]);
    if (a && mask && hasUv1) {
      const tg = (i) => (mat.texgens || [])[mat.stages[i].tg] || { su: 1, sv: 1 };
      const tex = [a, b || a, c || a, d || a].map((t) => t.tex);
      const uni = {
        tfMask: { value: mask.tex },
        tfA: { value: tex[0] }, tfB: { value: tex[1] }, tfC: { value: tex[2] }, tfD: { value: tex[3] },
        tfS: { value: [0, 1, 2, 3].map((i) => new THREE.Vector2(tg(i).su || 1, tg(i).sv || 1)) },
      };
      material.color.set('#ffffff');
      material.map = tex[0]; // active les UV dans le shader standard
      material.userData.extraTextures = [mask.tex, ...tex.slice(1)];
      material.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uni);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 auv1;\nvarying vec2 vTfUv1;')
          .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTfUv1 = auv1;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vTfUv1;\nuniform sampler2D tfMask, tfA, tfB, tfC, tfD;\nuniform vec2 tfS[4];')
          .replace('#include <map_fragment>', `
            vec3 tfM = texture2D(tfMask, vTfUv1).rgb;
            vec3 tfCol = texture2D(tfA, vMapUv * tfS[0]).rgb;
            tfCol = mix(tfCol, texture2D(tfB, vMapUv * tfS[1]).rgb, tfM.r);
            tfCol = mix(tfCol, texture2D(tfC, vMapUv * tfS[2]).rgb, tfM.g);
            tfCol = mix(tfCol, texture2D(tfD, vMapUv * tfS[3]).rgb, tfM.b);
            diffuseColor.rgb *= tfCol;`);
      };
      material.customProgramCacheKey = () => 'tf-multi';
      return true;
    }
    if (a) { material.map = a.tex; material.color.set('#ffffff'); return true; }
    return false;
  }
  // matériau simple : première texture de couleur déclarée
  const first = st.find(isCo);
  if (first) {
    const t = await loadTexture(src, first, texSize);
    if (t) { material.map = t.tex; material.color.set('#ffffff'); return true; }
  }
  return false;
}

export async function loadP3DParts(src, key, { maxFaces = 4000, texSize = 512 } = {}) {
  const u8 = await src.read(key);
  const lod = parseP3D(u8, { maxFaces });
  const pos = new THREE.BufferAttribute(lod.positions, 3);
  const nrm = new THREE.BufferAttribute(lod.normals, 3);
  const uv = new THREE.BufferAttribute(lod.uvs, 2);
  const uvB = lod.uvs1 ? new THREE.BufferAttribute(lod.uvs1, 2) : null;
  // regroupe les sections par texture
  const byTex = new Map();
  for (const g of lod.groups) {
    if (!g.count) continue;
    const k = g.texture || (g.mat ? '@' + g.material : '#' + (g.diffuse || []).join(','));
    let e = byTex.get(k);
    if (!e) byTex.set(k, (e = { texture: g.texture, diffuse: g.diffuse, mat: g.mat, ranges: [] }));
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
    if (uvB) geometry.setAttribute('auv1', uvB);
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
    } else if (e.mat && (await applyMaterialStages(src, e.mat, material, texSize, !!uvB))) {
      // textures trouvées dans le matériau (.rvmat)
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
    for (const t of [p.material.map, ...(p.material.userData.extraTextures || [])]) {
      if (t) { texCache.delete(t.userData.ck); t.dispose(); }
    }
    p.material.dispose();
  }
}
