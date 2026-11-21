import * as THREE from 'three';

// Types de routes ; "id" est exporté dans l'attribut ID du shapefile et
// correspond à une classe RoadXXXX du fichier RoadsLib.cfg.
export const DEFAULT_ROAD_TYPES = [
  { id: 1, name: 'Route principale (asphalte)', width: 10, color: '#3a3a3c', map: 'main road' },
  { id: 2, name: 'Route secondaire', width: 7, color: '#4a4a4a', map: 'road' },
  { id: 3, name: 'Chemin de terre', width: 4, color: '#7a6347', map: 'track' },
  { id: 4, name: 'Rue', width: 5.5, color: '#555557', map: 'road' },
  { id: 5, name: 'Sentier', width: 1.6, color: '#8a7658', map: 'trail' },
];

export class RoadManager {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.types = DEFAULT_ROAD_TYPES.map((t) => ({ ...t }));
    this.roads = []; // {type, points: [[x,z],...]}
    this.group = new THREE.Group();
    scene.add(this.group);
    this.draft = null; // route en cours de tracé
    this.draftLine = null;
    this.texFor = null; // (chemin .paa) => THREE.Texture | null, fourni par l'application
  }

  type(id) { return this.types.find((t) => t.id === id) || this.types[0]; }

  // Échantillonne la courbe lissée d'une route (points tous les ~step mètres).
  sample(road, step = 2) {
    const pts = road.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    if (pts.length < 2) return pts;
    if (road.raw) {
      // Tracé importé (OpenStreetMap) : déjà précis, simple densification linéaire.
      const out = [pts[0]];
      for (let k = 1; k < pts.length; k++) {
        const p = pts[k - 1], q = pts[k];
        const n = Math.max(1, Math.ceil(p.distanceTo(q) / step));
        for (let m = 1; m <= n; m++) out.push(p.clone().lerp(q, m / n));
      }
      return out;
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = Math.max(2, Math.ceil(curve.getLength() / step));
    return curve.getSpacedPoints(n);
  }

  // Un seul maillage par type de route (des milliers de routes restent fluides).
  rebuild() {
    for (const c of [...this.group.children]) { this.group.remove(c); c.geometry.dispose(); c.material.dispose(); }
    const byType = new Map();
    for (const road of this.roads) {
      if (road.points.length < 2) continue;
      const t = this.type(road.type);
      let acc = byType.get(t);
      if (!acc) byType.set(t, (acc = { pos: [], idx: [], uv: [] }));
      this.ribbon(road, t, acc);
    }
    for (const [t, acc] of byType) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
      geo.setIndex(acc.idx);
      geo.computeVertexNormals();
      const map = t.tex && this.texFor ? this.texFor(t.tex) : null;
      const mat = new THREE.MeshStandardMaterial({
        ...(map ? { map, transparent: true, depthWrite: false } : {}),
        color: map ? '#ffffff' : t.color, roughness: 1, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      this.group.add(new THREE.Mesh(geo, mat));
    }
  }

  ribbon(road, t, acc) {
    const pts = this.sample(road, Math.max(2, this.terrain.cell * 0.75));
    const { pos, idx, uv } = acc;
    const base = pos.length / 3;
    // Les textures de route d'Arma ont des bords transparents : la bande affichée est un peu plus large.
    const textured = !!(t.tex && this.texFor && this.texFor(t.tex));
    const hw = (t.width / 2) * (textured ? 1.3 : 1);
    let dist = 0;
    for (let k = 0; k < pts.length; k++) {
      if (k > 0) dist += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      for (const s of [-1, 1]) {
        const x = pts[k].x + nx * hw * s, z = pts[k].z + nz * hw * s;
        pos.push(x, this.terrain.heightAt(x, z) + 0.3, z);
        uv.push(s < 0 ? 0 : 1, dist / (hw * 2));
      }
      if (k > 0) {
        const i = base + k * 2;
        idx.push(i - 2, i - 1, i, i - 1, i + 1, i);
      }
    }
  }

  // ---- Tracé interactif ----
  startDraft(type) { this.draft = { type, points: [] }; this.updateDraft(); }
  addDraftPoint(x, z) { if (!this.draft) return; this.draft.points.push([x, z]); this.updateDraft(); }
  undoDraftPoint() { if (this.draft) { this.draft.points.pop(); this.updateDraft(); } }
  cancelDraft() { this.draft = null; this.updateDraft(); }
  finishDraft() {
    const d = this.draft;
    this.draft = null;
    this.updateDraft();
    if (d && d.points.length >= 2) { this.roads.push(d); this.rebuild(); return d; }
    return null;
  }
  updateDraft(hover) {
    if (this.draftLine) { this.scene.remove(this.draftLine); this.draftLine.geometry.dispose(); this.draftLine = null; }
    if (!this.draft) return;
    const pts = this.draft.points.map(([x, z]) => new THREE.Vector3(x, this.terrain.heightAt(x, z) + 1, z));
    if (hover) pts.push(new THREE.Vector3(hover.x, hover.y + 1, hover.z));
    if (pts.length < 1) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts.length === 1 ? [pts[0], pts[0]] : pts);
    this.draftLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
    this.draftLine.renderOrder = 10;
    this.scene.add(this.draftLine);
  }

  // Aplanit le terrain sous les routes (profil en long lissé + accotements adoucis).
  flattenUnder(roadList = this.roads, shoulder = 6) {
    const T = this.terrain;
    for (const road of roadList) {
      const t = this.type(road.type);
      const pts = this.sample(road, T.cell * 0.5);
      // Profil en long : altitude du sol lissée par moyenne glissante.
      const raw = pts.map((p) => T.heightAt(p.x, p.z));
      const win = Math.max(2, Math.round(40 / (T.cell * 0.5)));
      const prof = raw.map((_, k) => {
        let s = 0, n = 0;
        for (let m = Math.max(0, k - win); m <= Math.min(raw.length - 1, k + win); m++) { s += raw[m]; n++; }
        return s / n;
      });
      const hw = t.width / 2, R = hw + shoulder;
      pts.forEach((p, k) => {
        T.applyBrush(p.x, p.z, R, 0, (h, _w, i, j) => {
          const d = Math.hypot(i * T.cell - p.x, j * T.cell - p.z);
          const a = d <= hw ? 1 : 1 - (d - hw) / shoulder;
          return h + (prof[k] - h) * Math.max(0, a) * 0.6;
        });
      });
    }
  }
}
