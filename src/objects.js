import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

// Bibliothèque par défaut. "tbName" = nom du modèle tel qu'il apparaît dans la
// bibliothèque de Terrain Builder (souvent le nom du .p3d sans extension).
// Ce sont des exemples d'objets vanilla : vérifie-les dans ta propre bibliothèque TB.
export const DEFAULT_LIBRARY = [
  { id: 'pine',   name: 'Pin',            tbName: 't_PinusS2s_F',     shape: 'conifer', color: '#2f5a2a', height: 18 },
  { id: 'pine2',  name: 'Pin parasol',    tbName: 't_PinusP3s_F',     shape: 'umbrella', color: '#3c6630', height: 14 },
  { id: 'beech',  name: 'Hêtre',          tbName: 't_FagusS2s_F',     shape: 'leafy',   color: '#4b7a34', height: 20 },
  { id: 'oak',    name: 'Chêne',          tbName: 't_QuercusIR2s_F',  shape: 'leafy',   color: '#566f2e', height: 15 },
  { id: 'olive',  name: 'Olivier',        tbName: 't_OleaE1s_F',      shape: 'leafy',   color: '#7a8a52', height: 7 },
  { id: 'bush',   name: 'Buisson',        tbName: 'b_FicusC1s_F',     shape: 'bush',    color: '#4e6b32', height: 2.5 },
  { id: 'rock',   name: 'Rocher',         tbName: 'Land_W_sharpStone_01', shape: 'rock', color: '#85817a', height: 3 },
  { id: 'house',  name: 'Maison',         tbName: 'Land_i_House_Small_01_V1_F', shape: 'house', color: '#c9b79a', height: 6 },
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
      const wall = new THREE.MeshStandardMaterial({ color: col });
      const roof = new THREE.MeshStandardMaterial({ color: '#8a3b2a', flatShading: true });
      add(new THREE.BoxGeometry(10, H * 0.6, 7), wall, H * 0.3);
      add(new THREE.ConeGeometry(6.5, H * 0.4, 4).rotateY(Math.PI / 4).scale(1.1, 1, 0.8), roof, H * 0.8);
      break;
    }
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
