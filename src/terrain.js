import * as THREE from 'three';
import { makeNoise } from './noise.js';

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
    this.size = (gridSize - 1) * cellSize;
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

    this.buildMesh();
    this.redrawSurface(0, 0, maskRes - 1, maskRes - 1);
  }

  buildMesh() {
    const N = this.N;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        pos[k * 3] = i * this.cell;
        pos[k * 3 + 1] = this.heights[k];
        pos[k * 3 + 2] = j * this.cell;
        uv[k * 2] = i / (N - 1);
        uv[k * 2 + 1] = 1 - j / (N - 1);
      }
    }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let t = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);
    this.updateHeights(0, 0, N - 1, N - 1);
  }

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
    const N = this.N, c = this.cell;
    i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1);
    i1 = Math.min(N - 1, i1 + 1); j1 = Math.min(N - 1, j1 + 1);
    const pos = this.mesh.geometry.attributes.position;
    const nor = this.mesh.geometry.attributes.normal;
    const P = pos.array, NA = nor.array;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        P[k * 3 + 1] = this.heights[k];
        const nx = this.h(i - 1, j) - this.h(i + 1, j);
        const nz = this.h(i, j - 1) - this.h(i, j + 1);
        const ny = 2 * c;
        const len = Math.hypot(nx, ny, nz);
        NA[k * 3] = nx / len; NA[k * 3 + 1] = ny / len; NA[k * 3 + 2] = nz / len;
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
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

  generate({ seed = 1, amplitude = 120, scale = 1, base = 20, island = true }) {
    const { fbm } = makeNoise(seed);
    const N = this.N;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1), v = j / (N - 1);
        let h = fbm(u * 6 * scale, v * 6 * scale, 6);
        h = base + h * amplitude * 1.6;
        if (island) {
          const d = Math.hypot(u - 0.5, v - 0.5) * 2;
          const m = Math.max(0, 1 - Math.pow(d, 2.2));
          h = Math.max(h, base * 0.4) * m + (m - 0.3) * amplitude * 0.6;
        }
        this.heights[j * N + i] = h;
      }
    this.updateHeights(0, 0, N - 1, N - 1);
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
    return [(x / this.size) * (this.maskRes - 1), (z / this.size) * (this.maskRes - 1)];
  }

  paintSurface(x, z, r, idx, hardness = 1, rnd = Math.random) {
    const R = this.maskRes;
    const [px, pz] = this.worldToMask(x, z);
    const pr = (r / this.size) * (R - 1);
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
    const step = this.cell * 0.5;
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
