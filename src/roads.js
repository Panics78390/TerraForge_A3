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

  // Tablier d'un pont : droite tendue entre le sol de ses deux extrémités.
  // Renvoie { L, h0, h1, h(d) } : longueur du tracé et altitude du tablier à la distance d du début.
  deck(road) {
    const p = road.points, T = this.terrain;
    let L = 0;
    for (let k = 1; k < p.length; k++) L += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    const h0 = T.heightAt(p[0][0], p[0][1]), h1 = T.heightAt(p[p.length - 1][0], p[p.length - 1][1]);
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

  // Nivelle le terrain sous les routes pour qu'elles soient praticables. Tout le réseau
  // est lissé d'un seul tenant (les routes qui se rejoignent partagent leurs points, donc
  // pas de marche aux carrefours), puis le sol est remodelé : chaussée sans dévers,
  // accotements raccordés en douceur. Une route marquée `over` (pont non posé) est reliée
  // aux routes qu'elle croise : le croisement devient un carrefour à niveau.
  // Les ponts posés (`bridge`) ne touchent pas au sol qu'ils enjambent.
  flattenUnder(roadList = this.roads, shoulder = 5, passes = 2) {
    const T = this.terrain;
    for (let pass = 0; pass < passes; pass++) this.grade(roadList, shoulder);
    T.updateHeights(0, 0, T.N - 1, T.N - 1);
  }

  // Une passe de nivellement (voir flattenUnder). lambda règle la force du lissage :
  // la longueur lissée vaut environ step × √lambda (40 m par défaut).
  grade(roadList, shoulder = 5, lambda = 100, iters = 150, step = 4) {
    const T = this.terrain, N = T.N, c = T.cell, H = T.heights;
    const X = [], Z = [], G = [], ids = new Map(), ways = [], E0 = [], E1 = [], EW = [];
    const key = (p) => Math.round(p[0] * 20) + ',' + Math.round(p[1] * 20);
    // Importance d'une route : la plus importante impose son profil aux croisements
    // (elle est plus « raide » dans le lissage et gagne quand deux chaussées se recouvrent).
    const rank = (road) => ({ 1: 4, 2: 3, 4: 2, 3: 1, 5: 0 }[road.type] ?? 2);
    const END = new Set();     // extrémités de routes
    const WAY = [], HW = [];   // par point : route d'origine et demi-largeur
    let stiff = 1, cur = -1, curHw = 0;
    const node = (x, z, k) => {
      if (k !== null) { const id = ids.get(k); if (id !== undefined) return id; }
      const id = X.length;
      X.push(x); Z.push(z); G.push(T.heightAt(x, z)); WAY.push(cur); HW.push(curHw);
      if (k !== null) ids.set(k, id);
      return id;
    };
    const edge = (a, b, d, w = Math.min(4, step / Math.max(d, 0.5)) * stiff) => { if (a !== b) { E0.push(a); E1.push(b); EW.push(lambda * w); } };
    for (const road of roadList) {
      if (road.bridge || road.points.length < 2) continue;
      stiff = [0.6, 1, 1, 2, 4][rank(road)]; cur = ways.length; curHw = this.type(road.type).width / 2;
      const seq = [];
      if (road.raw) {
        let prev = node(road.points[0][0], road.points[0][1], key(road.points[0]));
        seq.push(prev);
        for (let k = 1; k < road.points.length; k++) {
          const [ax, az] = road.points[k - 1], [bx, bz] = road.points[k];
          const l = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(l / step));
          for (let m = 1; m <= n; m++) {
            const id = m === n ? node(bx, bz, key(road.points[k])) : node(ax + ((bx - ax) * m) / n, az + ((bz - az) * m) / n, null);
            edge(prev, id, l / n);
            prev = id; seq.push(id);
          }
        }
      } else {
        const p = this.sample(road, step);
        let prev = -1;
        p.forEach((q, i) => {
          const id = node(q.x, q.z, i === 0 || i === p.length - 1 ? key([q.x, q.z]) : null);
          if (prev >= 0) edge(prev, id, step);
          prev = id; seq.push(id);
        });
      }
      ways.push({ road, seq });
      END.add(seq[0]); END.add(seq[seq.length - 1]);
    }
    // Routes qui se recouvrent sans point commun (croisement non relié dans OpenStreetMap,
    // voie collée à une autre) : on les lie, elles doivent être à la même hauteur.
    stiff = 1;
    {
      const B = 12, hash = new Map();
      for (let i = 0; i < X.length; i++) { const k = Math.floor(X[i] / B) + ',' + Math.floor(Z[i] / B); let a = hash.get(k); if (!a) hash.set(k, (a = [])); a.push(i); }
      for (let i = 0; i < X.length; i++) {
        const gx = Math.floor(X[i] / B), gz = Math.floor(Z[i] / B);
        for (let ax = gx - 1; ax <= gx + 1; ax++) for (let az = gz - 1; az <= gz + 1; az++) {
          const a = hash.get(ax + ',' + az);
          if (a) for (const j of a) {
            if (j <= i || WAY[j] === WAY[i]) continue;
            const d = Math.hypot(X[j] - X[i], Z[j] - Z[i]);
            // une route qui se termine contre une autre s'y raccorde, même sans la toucher tout à fait
            const reach = END.has(i) ? HW[j] + 3 : END.has(j) ? HW[i] + 3 : 0;
            if (d < Math.max(Math.min(HW[i], HW[j]) + 1, reach)) edge(i, j, step, 2);
          }
        }
      }
    }
    // Croisements pont / route sans point commun.
    //  - pont posé ou emplacement libre (`bridge`) : la route du dessous est abaissée s'il le
    //    faut pour laisser `clearance` mètres sous le tablier (épaisseur du pont comprise) ;
    //    la contrainte entre dans le lissage, la descente se répartit donc en pente douce ;
    //  - mode « à niveau » (`over`) : les deux routes sont liées.
    const clearance = 6.2, F = new Float32Array(X.length).fill(1);
    const nearest = (seq, hit) => { let b = -1, bd = Infinity; for (const id of seq) { const d = Math.hypot(X[id] - hit[0], Z[id] - hit[1]); if (d < bd) { bd = d; b = id; } } return b; };
    for (const A of roadList) {
      if (!(A.bridge || A.over) || A.points.length < 2) continue;
      const pa = A.points, dk = A.bridge ? this.deck(A) : null;
      const wa = A.over ? ways.find((w) => w.road === A) : null;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of pa) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      for (const B of ways) {
        if (B.road === A || B.road.over) continue;
        const pb = B.road.points;
        let hit = null, along = 0;
        for (let k = 1; k < pb.length && !hit; k++) {
          const [ux, uz] = pb[k - 1], [vx, vz] = pb[k];
          if (Math.max(ux, vx) < x0 || Math.min(ux, vx) > x1 || Math.max(uz, vz) < z0 || Math.min(uz, vz) > z1) continue;
          let run = 0;
          for (let m = 1; m < pa.length; m++) {
            const [ex, ez] = pa[m - 1], [fx, fz] = pa[m], bl = Math.hypot(fx - ex, fz - ez);
            const den = (vx - ux) * (fz - ez) - (vz - uz) * (fx - ex);
            if (Math.abs(den) > 1e-9) {
              const u = ((ex - ux) * (fz - ez) - (ez - uz) * (fx - ex)) / den, v = ((ex - ux) * (vz - uz) - (ez - uz) * (vx - ux)) / den;
              if (u > 0 && u < 1 && v > 0 && v < 1) { hit = [ux + (vx - ux) * u, uz + (vz - uz) * u]; along = run + v * bl; break; }
            }
            run += bl;
          }
        }
        if (!hit) continue;
        const nb = nearest(B.seq, hit);
        if (wa) edge(nearest(wa.seq, hit), nb, step, 8);
        else if (dk && dk.L >= 20 && along > 3 && along < dk.L - 3) {
          const need = dk.h(along) - clearance;
          // abaissement limité : le relief réel contient déjà l'essentiel du passage
          if (G[nb] > need) { G[nb] = Math.max(need, G[nb] - 4); F[nb] = 300; }
        }
      }
    }
    // Lissage : chaque point reste proche du sol d'origine tout en s'alignant sur ses voisins.
    const n = X.length, h = Float64Array.from(G), den = Float64Array.from(F), start = new Int32Array(n + 1);
    for (let e = 0; e < E0.length; e++) { start[E0[e] + 1]++; start[E1[e] + 1]++; den[E0[e]] += EW[e]; den[E1[e]] += EW[e]; }
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n), AJ = new Int32Array(E0.length * 2), AW = new Float32Array(E0.length * 2);
    for (let e = 0; e < E0.length; e++) {
      AJ[fill[E0[e]]] = E1[e]; AW[fill[E0[e]]++] = EW[e];
      AJ[fill[E1[e]]] = E0[e]; AW[fill[E1[e]]++] = EW[e];
    }
    const relax = (i) => { let s = G[i] * F[i]; for (let q = start[i]; q < start[i + 1]; q++) s += AW[q] * h[AJ[q]]; h[i] = s / den[i]; };
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) relax(i);
      for (let i = n - 1; i >= 0; i--) relax(i);
    }
    // Remodelage du sol : moyenne pondérée par cellule des altitudes voulues.
    const sum = new Float32Array(N * N), wsum = new Float32Array(N * N), wmax = new Float32Array(N * N);
    // Près d'une extrémité de pont, la route qui y arrive l'emporte sur celle qui passe dessous.
    const ends = [];
    for (const road of roadList) if (road.bridge && road.points.length >= 2) ends.push(road.points[0], road.points[road.points.length - 1]);
    for (const { road, seq } of ways) {
      const core = this.type(road.type).width / 2 + c * 0.75, R = core + shoulder;
      const prio = [1, 3, 10, 30, 100][rank(road)];
      const mine = ends.filter((e) => key(e) === key(road.points[0]) || key(e) === key(road.points[road.points.length - 1]));
      for (let k = 0; k < seq.length; k++) {
        const a = seq[Math.max(0, k - 1)], b = seq[k];
        const steps = k === 0 ? 1 : Math.max(1, Math.ceil(Math.hypot(X[b] - X[a], Z[b] - Z[a]) / (c * 0.5)));
        for (let m = 1; m <= steps; m++) {
          const t = k === 0 ? 1 : m / steps;
          const px = X[a] + (X[b] - X[a]) * t, pz = Z[a] + (Z[b] - Z[a]) * t, target = h[a] + (h[b] - h[a]) * t;
          let boost = prio;
          for (const e of mine) if (Math.hypot(e[0] - px, e[1] - pz) < 12) boost = prio * 3;
          const i0 = Math.max(0, Math.floor((px - R) / c)), i1 = Math.min(N - 1, Math.ceil((px + R) / c));
          const j0 = Math.max(0, Math.floor((pz - R) / c)), j1 = Math.min(N - 1, Math.ceil((pz + R) / c));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(i * c - px, j * c - pz);
            if (d >= R) continue;
            let w = d <= core ? 1 : 1 - (d - core) / shoulder;
            w = w * w * (3 - 2 * w);
            const q = j * N + i, ww = w * w * w * w * boost;
            sum[q] += target * ww; wsum[q] += ww;
            if (w > wmax[q]) wmax[q] = w;
          }
        }
      }
    }
    for (let q = 0; q < N * N; q++) if (wsum[q] > 0) H[q] += (sum[q] / wsum[q] - H[q]) * wmax[q];
  }
}
