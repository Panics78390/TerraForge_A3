import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

// Bibliothèque par défaut. "tbName" = nom du modèle dans la bibliothèque de
// Terrain Builder (le nom du fichier .p3d sans extension).
// Ce sont des objets vanilla d'Arma 3, affichés ici sous forme simplifiée :
// vérifie les noms dans ta propre bibliothèque TB.
const T = (id, name, tbName, shape, color, height, extra = {}) => ({ id, name, tbName, shape, color, height, ...extra });
export const CATEGORIES = ['Arbres', 'Buissons', 'Rochers', 'Bâtiments', 'Murs et clôtures', 'Divers', 'Mes modèles'];
export const DEFAULT_LIBRARY = [
  ...[
    T('pine', 'Pin', 't_PinusS2s_F', 'conifer', '#2f5a2a', 18),
    T('pine_b', 'Pin (variante)', 't_PinusS2s_b_F', 'conifer', '#35612d', 15),
    T('pine2', 'Pin parasol', 't_PinusP3s_F', 'umbrella', '#3c6630', 14),
    T('beech', 'Frêne', 't_FraxinusAV2s_F', 'leafy', '#4b7a34', 20),
    T('oak', 'Chêne vert', 't_QuercusIR2s_F', 'leafy', '#566f2e', 15),
    T('olive', 'Olivier', 't_OleaE2s_F', 'leafy', '#7a8a52', 7),
    T('olive1', 'Olivier jeune', 't_OleaE1s_F', 'leafy', '#84935a', 5),
    T('ficus', 'Figuier', 't_FicusB2s_F', 'leafy', '#5a8038', 9),
    T('poplar', 'Peuplier', 't_PopulusN3s_F', 'poplar', '#4f7d35', 24),
    T('palm', 'Palmier', 't_PhoenixC3s_F', 'palm', '#5c8a3a', 11),
    T('mulberry', 'Mûrier', 't_BroussonetiaP1s_F', 'leafy', '#6a8a3e', 6),
  ].map((e) => ({ ...e, cat: 'Arbres' })),
  ...[
    T('bush', 'Buisson (figuier)', 'b_FicusC1s_F', 'bush', '#4e6b32', 2.5),
    T('bush2', 'Buisson dense', 'b_FicusC2s_F', 'bush', '#456330', 3.5),
    T('nerium', 'Laurier-rose', 'b_NeriumO2s_F', 'bush', '#5f7d3f', 3),
    T('nerium_d', 'Laurier-rose sec', 'b_NeriumO2d_F', 'bush', '#8a7a4a', 3),
    T('reed', 'Roseaux', 'b_ArundoD3s_F', 'bush', '#8c9a52', 4),
  ].map((e) => ({ ...e, cat: 'Buissons' })),
  ...[
    T('rock', 'Pierre pointue', 'SharpStone_01', 'rock', '#85817a', 3),
    T('rock2', 'Pierre pointue 2', 'SharpStone_02', 'rock', '#7d7972', 4),
    T('blunt', 'Pierre ronde', 'BluntStone_01', 'rock', '#8e8a82', 2.5),
    T('blunt2', 'Pierre ronde 2', 'BluntStone_02', 'rock', '#88847c', 3.5),
    T('rockwall', 'Paroi rocheuse', 'SharpRock_wallH', 'rock', '#77736c', 14),
    T('bluntwall', 'Gros rocher', 'BluntRock_wallH', 'rock', '#817d75', 12),
  ].map((e) => ({ ...e, cat: 'Rochers' })),
  ...[
    T('house', 'Petite maison', 'i_House_Small_01_V1_F', 'house', '#c9b79a', 6, { w: 10, d: 7 }),
    T('house2', 'Petite maison 2', 'i_House_Small_02_V1_F', 'house', '#d4c4a4', 5, { w: 12, d: 6 }),
    T('housebig', 'Grande maison', 'i_House_Big_01_V1_F', 'house', '#cdbb9c', 9, { w: 12, d: 10 }),
    T('housebig2', 'Grande maison 2', 'i_House_Big_02_V1_F', 'house', '#c4b08e', 9, { w: 14, d: 9 }),
    T('stonehouse', 'Maison en pierre', 'i_Stone_HouseSmall_V1_F', 'house', '#a79f90', 5, { w: 11, d: 6 }),
    T('stoneshed', 'Remise en pierre', 'i_Stone_Shed_V1_F', 'house', '#9d968a', 4, { w: 6, d: 5 }),
    T('shop', 'Boutique', 'i_Shop_01_V1_F', 'house', '#d9cdb5', 8, { w: 9, d: 12 }),
    T('garage', 'Garage', 'i_Garage_V1_F', 'house', '#bfb9ad', 4, { w: 9, d: 6 }),
    T('chapel', 'Chapelle', 'Chapel_V1_F', 'house', '#e4dccb', 9, { w: 8, d: 12 }),
    T('slum', 'Cabane', 'Slum_House01_F', 'house', '#8f7b62', 3.5, { w: 5, d: 4 }),
    T('shedbig', 'Hangar', 'Shed_Big_F', 'box', '#8f9498', 7, { w: 14, d: 20 }),
    T('cargohouse', 'Baraquement', 'Cargo_House_V1_F', 'box', '#6f7d5c', 3, { w: 6, d: 4 }),
  ].map((e) => ({ ...e, cat: 'Bâtiments' })),
  ...[
    T('stonewall', 'Mur en pierre 8 m', 'Stone_8m_F', 'wall', '#9a948a', 1.4, { w: 8 }),
    T('citywall', 'Mur de ville 8 m', 'City_8m_F', 'wall', '#cfc7b6', 2, { w: 8 }),
    T('netfence', 'Grillage 8 m', 'Net_Fence_8m_F', 'wall', '#7c8a8f', 2.2, { w: 8 }),
    T('indwall', 'Mur béton 4 m', 'Wall_IndCnc_4_F', 'wall', '#a9a9a4', 2.8, { w: 4 }),
    T('hbarrier', 'H-Barrier 5', 'HBarrier_5_F', 'box', '#a39676', 1.4, { w: 5.5, d: 1.3 }),
  ].map((e) => ({ ...e, cat: 'Murs et clôtures' })),
  ...[
    T('lamp', 'Lampadaire', 'LampStreet_F', 'pole', '#6b6f72', 7),
    T('powerpole', 'Poteau électrique', 'PowerPoleWooden_F', 'pole', '#6e563c', 9),
    T('watertower', 'Château d\'eau', 'WaterTower_01_F', 'box', '#9aa3a8', 12, { w: 5, d: 5 }),
  ].map((e) => ({ ...e, cat: 'Divers' })),
];

function primitiveParts(entry) {
  const H = entry.height || 10;
  const col = new THREE.Color(entry.color || '#888');
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#5b4330', roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.9, flatShading: true });
  const parts = [];
  const add = (geo, mat, y = 0) => {
    parts.push({ geometry: geo, material: mat, matrix: new THREE.Matrix4().makeTranslation(0, y, 0) });
  };
  switch (entry.shape) {
    case 'conifer':
      add(new THREE.CylinderGeometry(0.15 * H / 10, 0.25 * H / 10, H * 0.35, 5), trunkMat, H * 0.175);
      add(new THREE.ConeGeometry(H * 0.2, H * 0.75, 7), leafMat, H * 0.6);
      break;
    case 'umbrella':
      add(new THREE.CylinderGeometry(0.2, 0.35, H * 0.7, 5), trunkMat, H * 0.35);
      add(new THREE.SphereGeometry(H * 0.3, 7, 4).scale(1, 0.35, 1), leafMat, H * 0.8);
      break;
    case 'leafy':
      add(new THREE.CylinderGeometry(0.2 * H / 10, 0.35 * H / 10, H * 0.5, 5), trunkMat, H * 0.25);
      add(new THREE.IcosahedronGeometry(H * 0.3, 0), leafMat, H * 0.68);
      break;
    case 'bush':
      add(new THREE.IcosahedronGeometry(H * 0.5, 0).scale(1.3, 0.8, 1.3), leafMat, H * 0.35);
      break;
    case 'rock':
      add(new THREE.DodecahedronGeometry(H * 0.5, 0).scale(1.4, 0.7, 1), new THREE.MeshStandardMaterial({ color: col, flatShading: true }), H * 0.2);
      break;
    case 'house': {
      const W = entry.w || 10, D = entry.d || 7;
      const wall = new THREE.MeshStandardMaterial({ color: col });
      const roof = new THREE.MeshStandardMaterial({ color: '#8a3b2a', flatShading: true });
      add(new THREE.BoxGeometry(W, H * 0.6, D), wall, H * 0.3);
      add(new THREE.ConeGeometry(0.75, H * 0.4, 4).rotateY(Math.PI / 4).scale(W, 1, D), roof, H * 0.8);
      break;
    }
    case 'box':
      add(new THREE.BoxGeometry(entry.w || 4, H, entry.d || 4), new THREE.MeshStandardMaterial({ color: col }), H / 2);
      break;
    case 'wall':
      add(new THREE.BoxGeometry(entry.w || 8, H, 0.4), new THREE.MeshStandardMaterial({ color: col }), H / 2);
      break;
    case 'pole':
      add(new THREE.CylinderGeometry(0.12, 0.18, H, 6), new THREE.MeshStandardMaterial({ color: col }), H / 2);
      add(new THREE.BoxGeometry(1.6, 0.15, 0.15), new THREE.MeshStandardMaterial({ color: col }), H * 0.95);
      break;
    case 'poplar':
      add(new THREE.CylinderGeometry(0.2, 0.35, H * 0.3, 5), trunkMat, H * 0.15);
      add(new THREE.SphereGeometry(H * 0.12, 7, 6).scale(1, 3.4, 1), leafMat, H * 0.6);
      break;
    case 'palm':
      add(new THREE.CylinderGeometry(0.22, 0.35, H * 0.85, 6), trunkMat, H * 0.425);
      add(new THREE.ConeGeometry(H * 0.32, H * 0.22, 8).rotateX(Math.PI), leafMat, H * 0.9);
      break;
    default:
      add(new THREE.BoxGeometry(2, H, 2), new THREE.MeshStandardMaterial({ color: col }), H / 2);
  }
  return parts;
}

// Charge un modèle importé (GLB/GLTF/OBJ) depuis une dataURL ; renvoie les "parts".
export async function loadModelParts(dataUrl, format) {
  let root;
  const buf = await (await fetch(dataUrl)).arrayBuffer();
  if (format === 'obj') {
    root = new OBJLoader().parse(new TextDecoder().decode(buf));
  } else {
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
    root = gltf.scene;
  }
  root.updateMatrixWorld(true);
  // Pose le modèle sur le sol (bas de la boîte englobante à y = 0), centré en x/z.
  const box = new THREE.Box3().setFromObject(root);
  const offset = new THREE.Matrix4().makeTranslation(
    -(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const parts = [];
  root.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const material = mats[0] || new THREE.MeshStandardMaterial({ color: '#aaa' });
      parts.push({ geometry: o.geometry, material, matrix: offset.clone().multiply(o.matrixWorld) });
    }
  });
  const height = box.max.y - box.min.y;
  return { parts, height };
}

export class ObjectManager {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.library = [];
    this.objects = [];       // {lib, x, z, rot, scale}
    this.groups = new Map(); // lib id -> {parts, meshes: InstancedMesh[], capacity}
    this.root = new THREE.Group();
    scene.add(this.root);
    this.hashSize = 25;
    this.hash = new Map();
    this.dirty = new Set();
    this.selected = null;
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffcc00);
    this.selBox.visible = false;
    scene.add(this.selBox);
  }

  async setLibrary(lib) {
    this.library = [];
    for (const g of this.groups.values()) for (const m of g.meshes) this.root.remove(m);
    this.groups.clear();
    for (const e of lib) await this.addLibraryEntry(e, false);
    this.rebuildAll();
  }

  async addLibraryEntry(entry, rebuild = true) {
    let parts;
    if (entry.modelData) {
      const r = await loadModelParts(entry.modelData, entry.modelFormat);
      parts = r.parts;
      if (!entry.height) entry.height = r.height;
    } else parts = primitiveParts(entry);
    this.library.push(entry);
    this.groups.set(entry.id, { parts, meshes: [], capacity: 0 });
    if (rebuild) this.markDirty(entry.id);
    return entry;
  }

  removeLibraryEntry(id) {
    const g = this.groups.get(id);
    if (g) for (const m of g.meshes) this.root.remove(m);
    this.groups.delete(id);
    this.library = this.library.filter((e) => e.id !== id);
    this.setObjects(this.objects.filter((o) => o.lib !== id));
  }

  entry(id) { return this.library.find((e) => e.id === id); }

  // ---- Index spatial ----
  key(x, z) { return `${Math.floor(x / this.hashSize)},${Math.floor(z / this.hashSize)}`; }
  hashAdd(o) {
    const k = this.key(o.x, o.z);
    let b = this.hash.get(k);
    if (!b) this.hash.set(k, (b = []));
    b.push(o);
  }
  hashRemove(o) {
    const b = this.hash.get(this.key(o.x, o.z));
    if (b) { const i = b.indexOf(o); if (i >= 0) b.splice(i, 1); }
  }
  query(x, z, r) {
    const out = [];
    const s = this.hashSize;
    for (let gx = Math.floor((x - r) / s); gx <= Math.floor((x + r) / s); gx++)
      for (let gz = Math.floor((z - r) / s); gz <= Math.floor((z + r) / s); gz++) {
        const b = this.hash.get(`${gx},${gz}`);
        if (!b) continue;
        for (const o of b) if ((o.x - x) ** 2 + (o.z - z) ** 2 <= r * r) out.push(o);
      }
    return out;
  }

  add(o) {
    this.objects.push(o);
    this.hashAdd(o);
    this.markDirty(o.lib);
    return o;
  }

  remove(list) {
    const set = new Set(list);
    for (const o of list) { this.hashRemove(o); this.markDirty(o.lib); }
    this.objects = this.objects.filter((o) => !set.has(o));
    if (this.selected && set.has(this.selected)) this.select(null);
  }

  move(o, x, z) {
    this.hashRemove(o);
    o.x = x; o.z = z;
    this.hashAdd(o);
    this.markDirty(o.lib);
  }

  setObjects(list) {
    this.objects = list;
    this.hash.clear();
    for (const o of list) this.hashAdd(o);
    this.select(null);
    this.rebuildAll();
  }

  markDirty(id) { this.dirty.add(id); }
  rebuildAll() { for (const id of this.groups.keys()) this.dirty.add(id); this.flush(); }

  // Reconstruit les InstancedMesh des types modifiés (appelé à chaque image).
  flush() {
    if (!this.dirty.size) return;
    const byLib = new Map();
    for (const id of this.dirty) byLib.set(id, []);
    for (const o of this.objects) { const a = byLib.get(o.lib); if (a) a.push(o); }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const tmp = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [id, list] of byLib) {
      const g = this.groups.get(id);
      if (!g) continue;
      if (list.length > g.capacity || g.meshes.length === 0) {
        for (const mesh of g.meshes) { this.root.remove(mesh); mesh.dispose(); }
        g.capacity = Math.max(64, Math.ceil(list.length * 1.5));
        g.meshes = g.parts.map((part) => {
          const im = new THREE.InstancedMesh(part.geometry, part.material, g.capacity);
          im.castShadow = true;
          im.frustumCulled = false;
          this.root.add(im);
          return im;
        });
      }
      list.forEach((o, i) => {
        p.set(o.x, this.terrain.heightAt(o.x, o.z) + (o.dy || 0), o.z);
        q.setFromAxisAngle(up, o.rot);
        s.setScalar(o.scale);
        m.compose(p, q, s);
        g.parts.forEach((part, pi) => {
          tmp.multiplyMatrices(m, part.matrix);
          g.meshes[pi].setMatrixAt(i, tmp);
        });
      });
      for (const mesh of g.meshes) {
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.dirty.clear();
    this.updateSelBox();
  }

  // Après une modification du relief, les objets doivent suivre le sol.
  refreshHeights() { this.rebuildAll(); }

  pick(x, z, r = 6) {
    let best = null, bd = Infinity;
    for (const o of this.query(x, z, r)) {
      const d = (o.x - x) ** 2 + (o.z - z) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  select(o) {
    this.selected = o;
    this.updateSelBox();
  }

  updateSelBox() {
    const o = this.selected;
    if (!o) { this.selBox.visible = false; return; }
    const e = this.entry(o.lib);
    const H = (e?.height || 5) * o.scale;
    const y = this.terrain.heightAt(o.x, o.z);
    const box = new THREE.Box3(new THREE.Vector3(o.x - H * 0.3 - 1, y, o.z - H * 0.3 - 1), new THREE.Vector3(o.x + H * 0.3 + 1, y + H, o.z + H * 0.3 + 1));
    this.selBox.box = box;
    this.selBox.visible = true;
  }
}


// ---------- Vignettes ----------
let thumbGL = null;
const thumbCache = new Map();
export function clearThumb(id) { thumbCache.delete(id); }
// Rend une petite image (dataURL) d'un modèle de la bibliothèque.
export function thumbnail(mgr, id) {
  if (thumbCache.has(id)) return thumbCache.get(id);
  const g = mgr.groups.get(id);
  if (!g) return '';
  if (!thumbGL) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(128, 128, false);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#55504a', 1.6));
    const sun = new THREE.DirectionalLight('#fff', 2);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    thumbGL = { renderer, scene, cam: new THREE.PerspectiveCamera(30, 1, 0.1, 5000), holder: new THREE.Group() };
    scene.add(thumbGL.holder);
  }
  const { renderer, scene, cam, holder } = thumbGL;
  holder.clear();
  const box = new THREE.Box3();
  for (const p of g.parts) {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.matrixAutoUpdate = false;
    m.matrix.copy(p.matrix);
    holder.add(m);
  }
  holder.updateMatrixWorld(true);
  box.setFromObject(holder);
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const dist = r / Math.sin((15 * Math.PI) / 180) * 1.05;
  cam.position.set(c.x + dist * 0.62, c.y + dist * 0.42, c.z + dist * 0.66);
  cam.lookAt(c);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  thumbCache.set(id, url);
  return url;
}
