import { mulberry32 } from './noise.js';

// ======================================================================
// Générateur de terrain procédural.
// Tout est calculé point par point en coordonnées normalisées (u, v) dans
// [0, 1] : l'aperçu basse résolution et la carte finale donnent donc le
// même paysage. v = 0 est le bord nord.
// ======================================================================

export const STYLES = {
  flat:     { name: 'Plat',            diff: 0,   landform: 1500, rough: 20, ridges: 0,  erosion: 0 },
  gentle:   { name: 'Collines douces', diff: 70,  landform: 1600, rough: 25, ridges: 0,  erosion: 20 },
  hills:    { name: 'Collines',        diff: 190, landform: 1500, rough: 35, ridges: 10, erosion: 40 },
  uplands:  { name: 'Hauts plateaux',  diff: 460, landform: 1870, rough: 40, ridges: 30, erosion: 50 },
  mountains:{ name: 'Montagnes',       diff: 900, landform: 2200, rough: 55, ridges: 70, erosion: 65 },
};

export function defaultParams() {
  return {
    style: 'hills',
    low: 10,
    ...pick(STYLES.hills),
    seed: 28522,
    paint: true,
    sea: { on: true, mode: 'island', landmass: 55, dir: 0, seed: 28523 },
    rivers: { on: false, width: 14, depth: 6, auto: 0, springs: [] },
    shapes: {
      plateaus: { on: false, step: 40 },
      canyon: { on: false, depth: 80, width: 120, bends: 50, dir: 90, offset: 0 },
      volcano: { on: false, height: 300, size: 15, x: 70, y: 65, crater: 16, craterDepth: 30, slopes: 50, gullies: 50 },
      crater: { on: false, x: 30, y: 35, size: 8, depth: 60 },
    },
  };
}
function pick(s) { return { diff: s.diff, landform: s.landform, rough: s.rough, ridges: s.ridges, erosion: s.erosion }; }
export function applyStyle(params, id) { Object.assign(params, pick(STYLES[id]), { style: id }); }

// Bruit de valeur avec dérivées analytiques : out = [valeur, d/dx, d/dy]
function makeNoiseD(seed) {
  const rnd = mulberry32(seed >>> 0 || 1);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = rnd() * 2 - 1;
  return function (x, y, out) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const X = xi & 255, Y = yi & 255;
    const a = val[perm[X + perm[Y]]], b = val[perm[X + 1 + perm[Y]]];
    const c = val[perm[X + perm[Y + 1]]], d = val[perm[X + 1 + perm[Y + 1]]];
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const du = 30 * fx * fx * (fx * (fx - 2) + 1), dv = 30 * fy * fy * (fy * (fy - 2) + 1);
    const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    out[0] = a + k1 * u + k2 * v + k4 * u * v;
    out[1] = du * (k1 + k4 * v);
    out[2] = dv * (k2 + k4 * u);
  };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const TMP = [0, 0, 0];
const AMP = 1.15;

// fBm « érodé » : les octaves fines sont atténuées sur les pentes.
function terrainNoise(nd, x, y, gain, ridge, erosion) {
  let a = 1, sum = 0, norm = 0, dx = 0, dy = 0;
  for (let i = 0; i < 8; i++) {
    nd(x, y, TMP);
    let n = TMP[0], nx = TMP[1], ny = TMP[2];
    if (ridge > 0) {
      const s = n < 0 ? -1 : 1;
      n = n * (1 - ridge) + (1 - 2 * Math.abs(n)) * ridge;
      const ds = 1 - ridge - 2 * s * ridge;
      nx *= ds; ny *= ds;
    }
    dx += nx; dy += ny;
    sum += (a * n) / (1 + erosion * (dx * dx + dy * dy));
    norm += a; a *= gain;
    const x2 = 1.6 * x - 1.2 * y + 13.7, y2 = 1.2 * x + 1.6 * y + 7.3;
    x = x2; y = y2;
  }
  return sum / norm;
}

function fbm(nd, x, y, oct = 4) {
  let a = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    nd(x, y, TMP); s += a * TMP[0]; n += a; a *= 0.5;
    const x2 = 1.6 * x - 1.2 * y + 5.1, y2 = 1.2 * x + 1.6 * y + 9.2;
    x = x2; y = y2;
  }
  return s / n;
}

// Renvoie une fonction (u, v) -> altitude en mètres (sans les rivières).
export function makeSampler(P, sizeM) {
  const nd = makeNoiseD(P.seed);
  const nc = makeNoiseD(P.sea.seed + 77);
  const f0 = sizeM / Math.max(200, P.landform);
  const gain = 0.3 + (P.rough / 100) * 0.35;
  const ridge = P.ridges / 100;
  const eros = (P.erosion / 100) * 0.5;
  const sea = P.sea, sh = P.shapes;
  const L = sea.landmass / 100;
  const th = (sea.dir * Math.PI) / 180;
  const dirx = Math.sin(th), diry = -Math.cos(th); // côté du continent
  const vol = sh.volcano, cra = sh.crater, can = sh.canyon;
  const cth = (can.dir * Math.PI) / 180;
  const cdx = Math.sin(cth), cdy = -Math.cos(cth);

  function landMask(u, v) {
    const wu = u + 0.07 * fbm(nc, u * 3.1 + 4, v * 3.1, 3);
    const wv = v + 0.07 * fbm(nc, u * 3.1, v * 3.1 + 9, 3);
    const cx = wu - 0.5, cy = wv - 0.5;
    const detail = 0.07 * fbm(nc, u * 9 + 20, v * 9 + 3, 4);
    const p = (cx * dirx + cy * diry) * 2;
    let m;
    switch (sea.mode) {
      case 'coast':
        m = p - (1 - 2 * L);
        break;
      case 'peninsula': {
        const m1 = p - 0.62;
        // langue de terre : capsule du continent vers le large
        const a0 = 0.7, a1 = -(0.1 + 0.75 * L);
        const q = (cx * -diry + cy * dirx) * 2;
        const t = Math.min(a0, Math.max(a1, p));
        const w = 0.2 + 0.28 * L;
        const m2 = w - Math.hypot(p - t, q);
        m = Math.max(m1, m2);
        break;
      }
      case 'archipelago': {
        const d = Math.hypot(cx, cy) * 2;
        m = fbm(nc, u * 4.3 + 50, v * 4.3 + 31, 3) * 0.75 + (L - 0.62) * 0.9 - Math.max(0, d - 0.75) * 1.5;
        break;
      }
      default: { // île
        const d = Math.hypot(cx, cy) * 2;
        m = 0.3 + 0.68 * L - d;
      }
    }
    return m + detail;
  }

  return function sample(u, v) {
    const t = terrainNoise(nd, u * f0 + 31.4, v * f0 + 17.9, gain, ridge, eros);
    let h = P.low + P.diff * Math.min(1, Math.max(0, 0.5 + AMP * t));

    if (sh.plateaus.on) {
      const st = Math.max(5, sh.plateaus.step);
      const k = h / st, fl = Math.floor(k), fr = k - fl;
      h = (fl + smooth(0.35, 0.65, fr) * 0.85 + fr * 0.15) * st;
    }

    if (sea.on) {
      const m = landMask(u, v);
      if (m > 0) { const s = Math.min(1, m / 0.4); h = 1.2 + (h - 1.2) * s * s * (3 - 2 * s) * Math.min(1, 0.25 + s) + m * 6; }
      else h = -0.4 - 55 * smooth(0, 0.3, -m);
    }

    if (can.on) {
      const x = (u - 0.5) * sizeM, y = (v - 0.5) * sizeM;
      const along = x * cdx + y * cdy;
      let across = x * -cdy + y * cdx - (can.offset / 100) * sizeM * 0.5;
      nd((along / sizeM) * 3.2 + 91.3, 4.7, TMP);
      const w1 = TMP[0];
      nd((along / sizeM) * 8.1 + 11.3, 28.7, TMP);
      across -= (can.bends / 100) * sizeM * (0.11 * w1 + 0.03 * TMP[0]);
      const d = Math.abs(across);
      const carve = can.depth * (1 - smooth(can.width * 0.3, can.width, d));
      if (carve > 0 && h > 1) h = Math.max(1, h - carve);
    }

    if (vol.on) {
      const R = (vol.size / 100) * sizeM;
      const x = (u - vol.x / 100) * sizeM, y = (v - vol.y / 100) * sizeM;
      let r = Math.hypot(x, y) / R;
      if (r < 1.25) {
        const ang = Math.atan2(y, x);
        nd(ang * 5.5 + 40, r * 2.5 + 3, TMP);
        const g = TMP[0];
        nd(ang * 14 + 8, r * 4 + 60, TMP);
        r *= 1 + (vol.gullies / 100) * (0.1 * g + 0.04 * TMP[0]) * Math.min(1, r * 3);
        if (r < 1) {
          const ex = 0.8 + (vol.slopes / 100) * 1.8;
          const prof = (q) => Math.pow(1 - q, ex);
          const rc = Math.max(0.02, vol.crater / 100);
          const base = -15;
          let hv;
          if (r >= rc) hv = base + (vol.height - base) * prof(r);
          else {
            const rim = base + (vol.height - base) * prof(rc);
            const q = r / rc;
            hv = rim - (vol.craterDepth / 100) * vol.height * (1 - q * q) * (1 - q * q);
          }
          if (r < rc) h = hv; else h = Math.max(h, hv);
        }
      }
    }

    if (cra.on) {
      const R = (cra.size / 100) * sizeM;
      const r = Math.hypot((u - cra.x / 100) * sizeM, (v - cra.y / 100) * sizeM) / R;
      if (r < 1.6) {
        const k = 1 - r * r;
        if (r < 1) h -= cra.depth * k * k;
        const e = (r - 1) / 0.22;
        h += cra.depth * 0.3 * Math.exp(-e * e);
      }
    }
    return h;
  };
}

// ---------- Rivières ----------
const TRACE = 256;

function traceGrid(sampler) {
  const G = TRACE, g = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) g[j * G + i] = sampler((i + 0.5) / G, (j + 0.5) / G);
  return g;
}

function autoSprings(P, g) {
  const G = TRACE, rnd = mulberry32(P.seed * 7 + 3);
  let max = -Infinity;
  for (let k = 0; k < g.length; k++) if (g[k] > max) max = g[k];
  const out = [];
  let tries = 4000;
  while (out.length < P.rivers.auto && tries-- > 0) {
    const i = Math.floor(rnd() * G), j = Math.floor(rnd() * G);
    if (g[j * G + i] > Math.max(15, max * 0.55)) out.push({ u: (i + 0.5) / G, v: (j + 0.5) / G });
  }
  return out;
}

// Descend la pente depuis la source ; perce les cuvettes pour toujours atteindre
// la mer ou le bord. Renvoie [{u, v, bed}] avec un lit toujours descendant.
function traceRiver(g, spring, depth) {
  const G = TRACE;
  let i = Math.min(G - 1, Math.max(0, Math.floor(spring.u * G)));
  let j = Math.min(G - 1, Math.max(0, Math.floor(spring.v * G)));
  const seen = new Uint8Array(G * G);
  const cells = [];
  for (let step = 0; step < 6000; step++) {
    const k = j * G + i;
    cells.push(k); seen[k] = 1;
    if (g[k] <= 0 || i === 0 || j === 0 || i === G - 1 || j === G - 1) break;
    let best = -1, bh = g[k];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const n = (j + dj) * G + i + di;
      if (!seen[n] && g[n] < bh) { bh = g[n]; best = n; }
    }
    if (best < 0) {
      // cuvette : recherche en largeur de la cellule plus basse la plus proche
      const parent = new Map([[k, -1]]);
      const queue = [k];
      let found = -1;
      for (let q = 0; q < queue.length && queue.length < 30000; q++) {
        const c = queue[q], ci = c % G, cj = (c - ci) / G;
        if ((g[c] < g[k] - 0.05 && !seen[c]) || ci === 0 || cj === 0 || ci === G - 1 || cj === G - 1) { found = c; break; }
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
          const n = nj * G + ni;
          if (!parent.has(n)) { parent.set(n, c); queue.push(n); }
        }
      }
      if (found < 0) break;
      const back = [];
      for (let c = found; c !== k && c !== -1; c = parent.get(c)) back.push(c);
      back.reverse();
      for (let b = 0; b < back.length - 1; b++) { cells.push(back[b]); seen[back[b]] = 1; }
      best = back[back.length - 1];
    }
    i = best % G; j = (best - i) / G;
  }
  let pts = cells.map((k) => ({ u: ((k % G) + 0.5) / G, v: (Math.floor(k / G) + 0.5) / G, h: g[k] }));
  for (let pass = 0; pass < 3; pass++) {
    pts = pts.map((p, n) => {
      if (n === 0 || n === pts.length - 1) return p;
      const a = pts[n - 1], b = pts[n + 1];
      return { u: (a.u + 2 * p.u + b.u) / 4, v: (a.v + 2 * p.v + b.v) / 4, h: p.h };
    });
  }
  let bed = Infinity;
  for (const p of pts) { bed = Math.min(bed, p.h - depth); p.bed = Math.max(bed, -3); bed = p.bed; }
  return pts;
}

function carveRivers(heights, N, sizeM, rivers, width, depthUnused) {
  const cell = sizeM / N;
  const R = Math.max(width * 2.6, cell * 2);
  const hw = Math.max(width / 2, cell * 0.6);
  const dist = new Float32Array(N * N).fill(Infinity);
  const bed = new Float32Array(N * N);
  for (const pts of rivers) {
    for (let n = 0; n < pts.length - 1; n++) {
      const a = pts[n], b = pts[n + 1];
      const ax = a.u * sizeM, ay = a.v * sizeM, bx = b.u * sizeM, by = b.v * sizeM;
      const segs = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * 0.7)));
      for (let s = 0; s < segs; s++) {
        const t = s / segs;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, bd = a.bed + (b.bed - a.bed) * t;
        const i0 = Math.max(0, Math.floor((x - R) / cell)), i1 = Math.min(N - 1, Math.ceil((x + R) / cell));
        const j0 = Math.max(0, Math.floor((y - R) / cell)), j1 = Math.min(N - 1, Math.ceil((y + R) / cell));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(i * cell - x, j * cell - y);
          const k = j * N + i;
          if (d < dist[k]) { dist[k] = d; bed[k] = bd; }
        }
      }
    }
  }
  for (let k = 0; k < heights.length; k++) {
    const d = dist[k];
    if (d >= R || heights[k] <= bed[k]) continue;
    const t = d <= hw ? 0 : smooth(0, 1, (d - hw) / (R - hw));
    heights[k] = bed[k] + (heights[k] - bed[k]) * t;
  }
}

// Génère la grille d'altitude N x N (cellule = sizeM / N).
// Renvoie { heights, rivers } ; rivers = polylignes en mètres [[x, z], ...].
export function generate(P, N, sizeM, { rivers: withRivers = true } = {}) {
  const sampler = makeSampler(P, sizeM);
  const heights = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) heights[j * N + i] = sampler(i / N, v);
  }
  let rivers = [];
  if (withRivers && P.rivers.on) {
    const springs = [...P.rivers.springs];
    let g = null;
    if (springs.length || P.rivers.auto > 0) {
      g = N === TRACE ? shiftedCopy(heights) : traceGrid(sampler);
      if (P.rivers.auto > 0) springs.push(...autoSprings(P, g));
    }
    const paths = springs.map((s) => traceRiver(g, s, P.rivers.depth)).filter((p) => p.length > 3);
    if (paths.length) carveRivers(heights, N, sizeM, paths, P.rivers.width);
    rivers = paths.map((p) => p.map((q) => [q.u * sizeM, q.v * sizeM]));
  }
  return { heights, rivers };
}
const shiftedCopy = (h) => h.slice();

// ---------- Aperçu coloré ----------
// Remplit un tableau RGBA (N x N) : mer, plage, roche, terre, herbe + ombrage.
export function colorize(heights, N, sizeM, paint, rgba) {
  const cell = sizeM / N;
  const H = (i, j) => heights[(j < 0 ? 0 : j >= N ? N - 1 : j) * N + (i < 0 ? 0 : i >= N ? N - 1 : i)];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const h = H(i, j);
    const nx = H(i - 1, j) - H(i + 1, j), nz = H(i, j - 1) - H(i, j + 1), ny = 2 * cell;
    const nl = Math.hypot(nx, ny, nz);
    const slope = (Math.acos(ny / nl) * 180) / Math.PI;
    let shade = 0.5 + 0.75 * Math.max(0, (nx * -0.5 + ny * 0.7 + nz * -0.5) / (nl * 0.985));
    let r, g, b;
    if (h < 0) {
      const d = Math.min(1, -h / 45);
      r = 58 - 38 * d; g = 122 - 62 * d; b = 150 - 55 * d; shade = 1;
    } else if (!paint) { r = 92; g = 118; b = 58; }
    else if (h < 2.5) { r = 196; g = 182; b = 140; }
    else if (slope > 34) { r = 124; g = 118; b = 110; }
    else if (slope > 23) { r = 122; g = 100; b = 72; }
    else {
      const v = ((i * 7 + j * 13) % 5) * 2;
      r = 86 + v; g = 114 + v; b = 56;
    }
    const k = (j * N + i) * 4;
    rgba[k] = Math.min(255, r * shade); rgba[k + 1] = Math.min(255, g * shade); rgba[k + 2] = Math.min(255, b * shade); rgba[k + 3] = 255;
  }
}
