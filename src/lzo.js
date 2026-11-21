// Décompression LZO1X (utilisée dans les .p3d binarisés et les textures .paa)
// Retourne { out, ip } : ip = position dans src après le bloc compressé.
export function lzo1x(src, ip, outLen) {
  const out = new Uint8Array(outLen);
  let op = 0, t = 0, m = 0;
  const lit = (n) => { while (n-- > 0) out[op++] = src[ip++]; };
  const cpy = (n) => { while (n-- > 0) out[op++] = out[m++]; };
  let state = 0; // 0 = début de boucle, 1 = après 1re série littérale, 2 = match, 3 = match_next
  t = src[ip];
  if (t > 17) {
    ip++; t -= 17;
    if (t < 4) state = 3; else { lit(t); state = 1; }
  }
  for (;;) {
    if (op > outLen || ip > src.length || t !== t) throw new Error('LZO: flux invalide');
    if (state === 0) {
      t = src[ip++];
      if (t >= 16) { state = 2; continue; }
      if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 15 + src[ip++]; }
      lit(t + 3);
      state = 1;
    }
    if (state === 1) {
      t = src[ip++];
      if (t >= 16) { state = 2; continue; }
      m = op - 0x801 - (t >> 2) - (src[ip++] << 2);
      cpy(3);
      t = src[ip - 2] & 3;
      if (t === 0) { state = 0; continue; }
      state = 3;
    }
    if (state === 2) {
      if (t >= 64) {
        m = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
        t = (t >> 5) - 1;
        cpy(t + 2);
      } else if (t >= 32) {
        t &= 31;
        if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 31 + src[ip++]; }
        m = op - 1 - (src[ip] >> 2) - (src[ip + 1] << 6); ip += 2;
        cpy(t + 2);
      } else if (t >= 16) {
        m = op - ((t & 8) << 11);
        t &= 7;
        if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 7 + src[ip++]; }
        m -= (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
        if (m === op) break; // fin de flux
        m -= 0x4000;
        cpy(t + 2);
      } else {
        m = op - 1 - (t >> 2) - (src[ip++] << 2);
        cpy(2);
      }
      t = src[ip - 2] & 3;
      if (t === 0) { state = 0; continue; }
      state = 3;
    }
    if (state === 3) {
      lit(t);
      t = src[ip++];
      state = 2;
    }
    if (op > outLen || ip > src.length) throw new Error('LZO: flux invalide');
  }
  return { out, ip };
}
