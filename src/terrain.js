import * as THREE from 'three';

// Convention : la grille a N x N points. heights[j * N + i].
// i = colonne (vers l'est), j = ligne (j = 0 est le bord NORD, comme dans un fichier ASC).
// Monde three.js : x = i * cell, z = j * cell, y = altitude.
// Coordonnées Arma : est = x, nord = size - z.
export class Terrain {
  constructor(scene, { gridSize = 513, cellSize = 10, maskRes = 1024, surfaces }) {
    this.scene = scene;
    this.surfaces = surfaces;
    this.init(gridSize, cellSize, maskRes);
  }

  init(gridSize, cellSize, maskRes) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.texture.dispose();
    }
    this.N = gridSize;
    this.cell = cellSize;
    this.size = gridSize * cellSize; // convention Terrain Builder : grille x cellule
    this.stride = Math.max(1, Math.ceil(gridSize / 1024)); // maillage d'affichage allégé
    this.M = Math.ceil((gridSize - 1) / this.stride) + 1;
    this.heights = new Float32Array(gridSize * gridSize);
    this.maskRes = maskRes;
    this.surf = new Uint8Array(maskRes * maskRes); // index de surface par pixel

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = maskRes;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.imageData = this.ctx.createImageData(maskRes, maskRes);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;

    if (this.satTexture) this.satTexture.dispose();
    this.sat = null;         // image satellite réelle (canvas), si importée
    this.satTexture = null;
    this.showSat = false;

    this.buildMesh();
    this.redrawSurface(0, 0, maskRes - 1, maskRes - 1);
  }

  // Indice de grille d'un sommet du maillage d'affichage.
  gi(a) { return Math.min(a * this.stride, this.N - 1); }

  buildMesh() {
    const M = this.M;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(M * M * 3);
    const uv = new Float32Array(M * M * 2);
    for (let b = 0; b < M; b++) {
      for (let a = 0; a < M; a++) {
        const k = b * M + a;
        const x = this.gi(a) * this.cell, z = this.gi(b) * this.cell;
        pos[k * 3] = x;
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / this.size;
        uv[k * 2 + 1] = 1 - (z + this.cell) / this.size;
      }
    }
    const idx = new Uint32Array((M - 1) * (M - 1) * 6);
    let t = 0;
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < M - 1; i++) {
        const a = j * M + i, b = a + 1, c = a + M, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(M * M * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(this.size / 2, 0, this.size / 2), this.size * 2);
    const mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.updateHeights(0, 0, this.N - 1, this.N - 1);
  }

  // Image satellite réelle : affichée à la place des couleurs de surface.
  setSat(canvas) {
    if (this.satTexture) this.satTexture.dispose();
    this.sat = canvas;
    this.satTexture = canvas ? new THREE.CanvasTexture(canvas) : null;
    if (this.satTexture) { this.satTexture.colorSpace = THREE.SRGBColorSpace; this.satTexture.anisotropy = 8; }
    this.setShowSat(!!canvas);
  }
  setShowSat(on) {
    this.showSat = on && !!this.satTexture;
    this.mesh.material.map = this.showSat ? this.satTexture : this.texture;
    this.mesh.material.needsUpdate = true;
  }

  // Coordonnée nord (Y Arma) d'une position z du monde 3D.
  north(z) { return (this.N - 1) * this.cell - z; }

  // ---- Altitudes ----
  h(i, j) {
    const N = this.N;
    i = i < 0 ? 0 : i >= N ? N - 1 : i;
    j = j < 0 ? 0 : j >= N ? N - 1 : j;
    return this.heights[j * N + i];
  }

  heightAt(x, z) {
    const fi = x / this.cell, fj = z / this.cell;
    const i = Math.floor(fi), j = Math.floor(fj);
    const u = fi - i, v = fj - j;
    const h00 = this.h(i, j), h10 = this.h(i + 1, j), h01 = this.h(i, j + 1), h11 = this.h(i + 1, j + 1);
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  }

  inside(x, z) {
    return x >= 0 && z >= 0 && x <= this.size && z <= this.size;
  }

  // Met à jour la géométrie (positions + normales) sur un rectangle de la grille.
  updateHeights(i0, j0, i1, j1) {
    const M = this.M, st = this.stride, c = this.cell;
    const a0 = Math.max(0, Math.floor(i0 / st) - 1), a1 = Math.min(M - 1, Math.ceil(i1 / st) + 1);
    const b0 = Math.max(0, Math.floor(j0 / st) - 1), b1 = Math.min(M - 1, Math.ceil(j1 / st) + 1);
    const pos = this.mesh.geometry.attributes.position;
    const nor = this.mesh.geometry.attributes.normal;
    const P = pos.array, NA = nor.array;
    for (let b = b0; b <= b1; b++) {
      const j = this.gi(b);
      for (let a = a0; a <= a1; a++) {
        const i = this.gi(a);
        const k = b * M + a;
        P[k * 3 + 1] = this.heights[j * this.N + i];
        const nx = this.h(i - st, j) - this.h(i + st, j);
        const nz = this.h(i, j - st) - this.h(i, j + st);
        const ny = 2 * c * st;
        const len = Math.hypot(nx, ny, nz);
        NA[k * 3] = nx / len; NA[k * 3 + 1] = ny / len; NA[k * 3 + 2] = nz / len;
      }
    }
    const start = b0 * M * 3, count = (b1 - b0 + 1) * M * 3;
    pos.addUpdateRange(start, count); nor.addUpdateRange(start, count);
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  // Applique une fonction à chaque point de grille dans le cercle (x,z,r).
  // fn(currentHeight, weight 0..1, i, j) -> nouvelle altitude
  applyBrush(x, z, r, falloff, fn) {
    const c = this.cell, N = this.N;
    const i0 = Math.max(0, Math.floor((x - r) / c)), i1 = Math.min(N - 1, Math.ceil((x + r) / c));
    const j0 = Math.max(0, Math.floor((z - r) / c)), j1 = Math.min(N - 1, Math.ceil((z + r) / c));
    if (i0 > i1 || j0 > j1) return;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * c - x, j * c - z) / r;
        if (d > 1) continue;
        const w = brushWeight(d, falloff);
        const k = j * N + i;
        this.heights[k] = fn(this.heights[k], w, i, j);
      }
    }
    this.updateHeights(i0, j0, i1, j1);
  }

  smoothBrush(x, z, r, falloff, strength) {
    const c = this.cell, N = this.N;
    const i0 = Math.max(0, Math.floor((x - r) / c)), i1 = Math.min(N - 1, Math.ceil((x + r) / c));
    const j0 = Math.max(0, Math.floor((z - r) / c)), j1 = Math.min(N - 1, Math.ceil((z + r) / c));
    if (i0 > i1 || j0 > j1) return;
    const w = i1 - i0 + 1;
    const tmp = new Float32Array(w * (j1 - j0 + 1));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += this.h(i + di, j + dj);
        tmp[(j - j0) * w + (i - i0)] = s / 9;
      }
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * c - x, j * c - z) / r;
        if (d > 1) continue;
        const k = j * N + i;
        const a = brushWeight(d, falloff) * strength;
        this.heights[k] += (tmp[(j - j0) * w + (i - i0)] - this.heights[k]) * a;
      }
    this.updateHeights(i0, j0, i1, j1);
  }

  flatAll(h = 10) {
    this.heights.fill(h);
    this.updateHeights(0, 0, this.N - 1, this.N - 1);
  }

  // Ré-échantillonne une grille source (w x hgt) dans la grille du terrain.
  loadHeightGrid(src, w, hgt) {
    const N = this.N;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const fx = (i / (N - 1)) * (w - 1), fy = (j / (N - 1)) * (hgt - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(hgt - 1, y0 + 1);
        const u = fx - x0, v = fy - y0;
        const a = src[y0 * w + x0], b = src[y0 * w + x1], cc = src[y1 * w + x0], d = src[y1 * w + x1];
        this.heights[j * N + i] = (a * (1 - u) + b * u) * (1 - v) + (cc * (1 - u) + d * u) * v;
      }
    this.updateHeights(0, 0, N - 1, N - 1);
  }

  // ---- Surfaces (masque) ----
  worldToMask(x, z) {
    return [(x / this.size) * this.maskRes, ((z + this.cell) / this.size) * this.maskRes];
  }

  // Centre d'un pixel du masque -> position dans le monde 3D.
  maskToWorld(px, py) {
    return [((px + 0.5) / this.maskRes) * this.size, ((py + 0.5) / this.maskRes) * this.size - this.cell];
  }

  paintSurface(x, z, r, idx, hardness = 1, rnd = Math.random) {
    const R = this.maskRes;
    const [px, pz] = this.worldToMask(x, z);
    const pr = Math.max(0.75, (r / this.size) * R);
    const x0 = Math.max(0, Math.floor(px - pr)), x1 = Math.min(R - 1, Math.ceil(px + pr));
    const y0 = Math.max(0, Math.floor(pz - pr)), y1 = Math.min(R - 1, Math.ceil(pz + pr));
    for (let y = y0; y <= y1; y++)
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - px, y - pz) / pr;
        if (d > 1) continue;
        // Bord légèrement "dispersé" pour éviter les cercles parfaits.
        if (d > hardness && rnd() > (1 - d) / (1 - hardness + 1e-6)) continue;
        this.surf[y * R + xx] = idx;
      }
    this.redrawSurface(x0, y0, x1, y1);
  }

  redrawSurface(x0, y0, x1, y1) {
    const R = this.maskRes, D = this.imageData.data;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = y * R + x;
        const s = this.surfaces[this.surf[k]] || this.surfaces[0];
        const n = hash2(x, y) * 18 - 9;
        D[k * 4] = clamp255(s.sat[0] + n);
        D[k * 4 + 1] = clamp255(s.sat[1] + n);
        D[k * 4 + 2] = clamp255(s.sat[2] + n * 0.8);
        D[k * 4 + 3] = 255;
      }
    this.ctx.putImageData(this.imageData, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    this.texture.needsUpdate = true;
  }

  // ---- Lancer de rayon contre la grille d'altitude ----
  raycast(ray) {
    const o = ray.origin, d = ray.direction;
    const step = this.cell * 0.75;
    const maxDist = this.size * 3;
    let prevT = 0;
    let above = o.y - this.heightAt(o.x, o.z) > 0;
    if (!above) return null;
    for (let t = step; t < maxDist; t += step) {
      const x = o.x + d.x * t, z = o.z + d.z * t, y = o.y + d.y * t;
      if (y < this.heightAt(x, z)) {
        let a = prevT, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          const mx = o.x + d.x * m, mz = o.z + d.z * m;
          if (o.y + d.y * m < this.heightAt(mx, mz)) b = m; else a = m;
        }
        const p = new THREE.Vector3(o.x + d.x * b, 0, o.z + d.z * b);
        if (!this.inside(p.x, p.z)) return null;
        p.y = this.heightAt(p.x, p.z);
        return p;
      }
      prevT = t;
      if (y < -2000) break;
    }
    return null;
  }

  slopeAt(x, z) {
    const c = this.cell;
    const dx = (this.heightAt(x + c, z) - this.heightAt(x - c, z)) / (2 * c);
    const dz = (this.heightAt(x, z + c) - this.heightAt(x, z - c)) / (2 * c);
    return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
  }
}

export function brushWeight(d, falloff) {
  // falloff 0 = dur, 1 = très doux
  const inner = 1 - falloff;
  if (d <= inner) return 1;
  const t = (d - inner) / (falloff + 1e-6);
  return 0.5 * (1 + Math.cos(Math.PI * Math.min(1, t)));
}

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
