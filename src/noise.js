// Bruit de valeur 2D simple + fBm, déterministe par graine.
export function makeNoise(seed = 1) {
  const perm = new Uint16Array(512);
  const p = new Uint16Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = new Float32Array(256);
  for (let i = 0; i < 256; i++) grad[i] = rnd() * 2 - 1;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const v00 = grad[perm[X + perm[Y]]], v10 = grad[perm[X + 1 + perm[Y]]];
    const v01 = grad[perm[X + perm[Y + 1]]], v11 = grad[perm[X + 1 + perm[Y + 1]]];
    const u = fade(xf), v = fade(yf);
    return (v00 + (v10 - v00) * u) * (1 - v) + (v01 + (v11 - v01) * u) * v;
  }
  function fbm(x, y, oct = 5) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * noise(x * f, y * f);
      norm += a; a *= 0.5; f *= 2;
    }
    return sum / norm;
  }
  return { noise, fbm };
}

// Générateur pseudo-aléatoire reproductible.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
