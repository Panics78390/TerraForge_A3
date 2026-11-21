import * as THREE from 'three';

// Types de routes ; "id" est exporté dans l'attribut ID du shapefile et
// correspond à une classe RoadXXXX du fichier RoadsLib.cfg.
export const DEFAULT_ROAD_TYPES = [
  { id: 1, name: 'Route principale (asphalte)', width: 10, color: '#3a3a3c', map: 'main road' },
  { id: 2, name: 'Route secondaire', width: 7, color: '#4a4a4a', map: 'road' },
  { id: 3, name: 'Chemin de terre', width: 4, color: '#7a6347', map: 'track' },
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
  }

  type(id) { return this.types.find((t) => t.id === id) || this.types[0]; }

  // Échantillonne la courbe lissée d'une route (points tous les ~step mètres).
  sample(road, step = 2) {
    const pts = road.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    if (pts.length < 2) return pts;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = Math.max(2, Math.ceil(curve.getLength() / step));
    return curve.getSpacedPoints(n);
  }

  rebuild() {
    for (const c of [...this.group.children]) { this.group.remove(c); c.geometry.dispose(); c.material.dispose(); }
    for (const road of this.roads) {
      if (road.points.length < 2) continue;
      this.group.add(this.ribbon(road));
    }
  }

  ribbon(road) {
    const t = this.type(road.type);
    const pts = this.sample(road, 2);
    const pos = [], idx = [];
    const hw = t.width / 2;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      for (const s of [-1, 1]) {
        const x = pts[k].x + nx * hw * s, z = pts[k].z + nz * hw * s;
        pos.push(x, this.terrain.heightAt(x, z) + 0.25, z);
      }
      if (k > 0) {
        const i = k * 2;
        idx.push(i - 2, i - 1, i, i - 1, i + 1, i);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: t.color, roughness: 1, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    return new THREE.Mesh(geo, mat);
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
