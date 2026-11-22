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
    this.selected = null;    // route sélectionnée (mode « Modifier »)
    this.activePoint = -1;   // point de la route sélectionnée en cours d'édition
    this.selGroup = new THREE.Group();
    scene.add(this.selGroup);
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
    if (this.selected && !this.roads.includes(this.selected)) this.select(null);
    else this.updateSelection();
  }

  // ---- Sélection et modification d'une route existante ----
  // Longueur du tracé (m).
  length(road) {
    const pts = this.sample(road, 4);
    let d = 0;
    for (let k = 1; k < pts.length; k++) d += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    return d;
  }

  // Distance d'un point au tracé d'une route (polyligne échantillonnée).
  distanceTo(road, x, z, step = 4) {
    const pts = road.raw ? road.points.map(([px, pz]) => ({ x: px, z: pz })) : this.sample(road, step);
    let best = Infinity;
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1].x, az = pts[k - 1].z, bx = pts[k].x, bz = pts[k].z;
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d < best) best = d;
    }
    return best;
  }

  // Route la plus proche du point (x, z), à moins de `margin` mètres de son bord.
  pick(x, z, margin = 4) {
    let best = null, bd = Infinity;
    for (const road of this.roads) {
      if (road.points.length < 2) continue;
      // rejet rapide par la boîte englobante
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [px, pz] of road.points) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (pz < z0) z0 = pz; if (pz > z1) z1 = pz; }
      const reach = this.type(road.type).width / 2 + margin + (road.raw ? 0 : 30);
      if (x < x0 - reach || x > x1 + reach || z < z0 - reach || z > z1 + reach) continue;
      const d = this.distanceTo(road, x, z) - this.type(road.type).width / 2;
      if (d <= margin && d < bd) { bd = d; best = road; }
    }
    return best;
  }

  // Point de contrôle de la route le plus proche de (x, z), ou -1.
  pickPoint(road, x, z, radius) {
    let best = -1, bd = radius;
    road.points.forEach(([px, pz], k) => { const d = Math.hypot(px - x, pz - z); if (d <= bd) { bd = d; best = k; } });
    return best;
  }

  select(road, point = -1) {
    this.selected = road || null;
    this.activePoint = road ? point : -1;
    this.updateSelection();
  }

  // Ajoute un point sur le tracé, à l'endroit le plus proche de (x, z). Renvoie son rang.
  insertPoint(road, x, z) {
    const p = road.points;
    let best = 1, bd = Infinity, bx = x, bz = z;
    for (let k = 1; k < p.length; k++) {
      const ax = p[k - 1][0], az = p[k - 1][1], dx = p[k][0] - ax, dz = p[k][1] - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const qx = ax + dx * t, qz = az + dz * t, d = Math.hypot(x - qx, z - qz);
      if (d < bd) { bd = d; best = k; bx = road.raw ? qx : x; bz = road.raw ? qz : z; }
    }
    p.splice(best, 0, [Math.round(bx * 100) / 100, Math.round(bz * 100) / 100]);
    return best;
  }

  // Surbrillance de la route sélectionnée : bande jaune + poignées sur ses points.
  updateSelection() {
    for (const c of [...this.selGroup.children]) { this.selGroup.remove(c); c.geometry.dispose(); c.material.dispose(); }
    const road = this.selected;
    if (!road || road.points.length < 2) return;
    const t = this.type(road.type);
    const acc = { pos: [], idx: [], uv: [] };
    this.ribbon(road, { width: t.width * 1.25 + 1 }, acc);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
    geo.setIndex(acc.idx);
    const band = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide }));
    band.renderOrder = 9;
    this.selGroup.add(band);
    const dk = road.bridge ? this.deck(road) : null;
    let run = 0;
    const at = ([x, z], k) => {
      if (k > 0) run += Math.hypot(x - road.points[k - 1][0], z - road.points[k - 1][1]);
      return new THREE.Vector3(x, this.surfaceAt(road, x, z, run, dk) + 0.8, z);
    };
    const dots = (list, color, size) => {
      if (!list.length) return;
      const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list), new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 11;
      this.selGroup.add(m);
    };
    const handles = road.points.map(at);
    dots(handles, 0xffffff, 9);
    dots(handles, 0x1f6feb, 6);
    if (handles[this.activePoint]) dots([handles[this.activePoint]], 0xff3b30, 13);
  }

  // Tablier d'un pont : droite tendue entre le sol de ses deux extrémités (on prend le
  // point le plus haut juste avant la culée, le relief y étant déjà un peu en pente).
  // Renvoie { L, h(d) } : longueur du tracé et altitude du tablier à la distance d du début.
  deck(road) {
    const p = road.points, T = this.terrain;
    let L = 0;
    for (let k = 1; k < p.length; k++) L += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    const end = (a, b) => {
      const dx = a[0] - b[0], dz = a[1] - b[1], l = Math.hypot(dx, dz) || 1;
      let h = -Infinity;
      for (const d of [0, T.cell, T.cell * 2]) h = Math.max(h, T.heightAt(a[0] + (dx / l) * d, a[1] + (dz / l) * d));
      return h;
    };
    const h0 = end(p[0], p[1]), h1 = end(p[p.length - 1], p[p.length - 2]);
    return { L, h0, h1, h: (d) => h0 + (h1 - h0) * (L > 0 ? Math.max(0, Math.min(1, d / L)) : 0) };
  }

  // Altitude de la chaussée au point (x, z) d'une route, à la distance d de son début.
  surfaceAt(road, x, z, d, deck) {
    const g = this.terrain.heightAt(x, z);
    return deck ? Math.max(g, deck.h(d)) : g;
  }

  ribbon(road, t, acc) {
    const pts = this.sample(road, Math.max(2, this.terrain.cell * 0.75));
    const deck = road.bridge && road.points.length >= 2 ? this.deck(road) : null;
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
        pos.push(x, this.surfaceAt(road, x, z, dist, deck) + 0.3, z);
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
      if (road.bridge) continue; // un pont ne modifie pas le sol qu'il enjambe
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
