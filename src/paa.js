import { lzo1x } from './lzo.js';

// Lecteur de textures Arma (.paa) : formats DXT1 / DXT3 / DXT5.
// parsePaaHeader lit le début du fichier ; decodePaaMip décode un niveau en RGBA.
export function parsePaaHeader(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const type = dv.getUint16(0, true);
  let p = 2;
  const tags = {};
  while (p + 12 <= u8.length && u8[p] === 0x47 && u8[p + 1] === 0x47 && u8[p + 2] === 0x41 && u8[p + 3] === 0x54) {
    const name = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const len = dv.getUint32(p + 8, true);
    tags[name] = u8.subarray(p + 12, p + 12 + len);
    p += 12 + len;
  }
  const nPal = dv.getUint16(p, true);
  p += 2 + nPal * 3;
  const offsets = [];
  if (tags.SFFO) {
    const o = new DataView(tags.SFFO.buffer, tags.SFFO.byteOffset, tags.SFFO.byteLength);
    for (let i = 0; i + 4 <= tags.SFFO.length; i += 4) { const v = o.getUint32(i, true); if (v) offsets.push(v); }
  }
  if (!offsets.length) offsets.push(p);
  let w = 0, h = 0;
  if (offsets[0] + 4 <= u8.length) { w = dv.getUint16(offsets[0], true) & 0x7fff; h = dv.getUint16(offsets[0] + 2, true); }
  return { type, offsets, width: w, height: h, alphaFlag: !!(tags.GALF && tags.GALF[0]) };
}

// u8 commence exactement à l'en-tête du niveau (largeur, hauteur, taille sur 3 octets, données)
export function decodePaaMip(type, u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let w = dv.getUint16(0, true); const h = dv.getUint16(2, true);
  const size = u8[4] | (u8[5] << 8) | (u8[6] << 16);
  const lzo = (w & 0x8000) !== 0; w &= 0x7fff;
  if (!w || !h) throw new Error('niveau vide');
  const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
  const blockSize = type === 0xff01 ? 8 : (type >= 0xff02 && type <= 0xff05) ? 16 : 0;
  if (!blockSize) throw new Error('format de texture non pris en charge');
  let data = u8.subarray(7, 7 + size);
  if (lzo) data = lzo1x(data, 0, bw * bh * blockSize).out;
  const out = new Uint8Array(w * h * 4);
  const col = new Uint8Array(16), al = new Uint8Array(8);
  let p = 0, hasAlpha = false;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let a0 = 0, a1 = 0, abits = null, a3 = null;
    if (blockSize === 16) {
      if (type === 0xff05 || type === 0xff04) {
        a0 = data[p]; a1 = data[p + 1];
        al[0] = a0; al[1] = a1;
        if (a0 > a1) for (let i = 1; i < 7; i++) al[i + 1] = ((7 - i) * a0 + i * a1) / 7;
        else { for (let i = 1; i < 5; i++) al[i + 1] = ((5 - i) * a0 + i * a1) / 5; al[6] = 0; al[7] = 255; }
        abits = [data[p + 2] | (data[p + 3] << 8) | (data[p + 4] << 16), data[p + 5] | (data[p + 6] << 8) | (data[p + 7] << 16)];
      } else a3 = p;
      p += 8;
    }
    const c0 = data[p] | (data[p + 1] << 8), c1 = data[p + 2] | (data[p + 3] << 8);
    const r0 = (c0 >> 11) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
    const r1 = (c1 >> 11) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;
    col[0] = r0; col[1] = g0; col[2] = b0; col[3] = 255;
    col[4] = r1; col[5] = g1; col[6] = b1; col[7] = 255;
    if (c0 > c1 || blockSize === 16) {
      col[8] = (2 * r0 + r1) / 3; col[9] = (2 * g0 + g1) / 3; col[10] = (2 * b0 + b1) / 3; col[11] = 255;
      col[12] = (r0 + 2 * r1) / 3; col[13] = (g0 + 2 * g1) / 3; col[14] = (b0 + 2 * b1) / 3; col[15] = 255;
    } else {
      col[8] = (r0 + r1) / 2; col[9] = (g0 + g1) / 2; col[10] = (b0 + b1) / 2; col[11] = 255;
      col[12] = 0; col[13] = 0; col[14] = 0; col[15] = 0;
    }
    const bits = data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24);
    p += 8;
    for (let k = 0; k < 16; k++) {
      const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
      if (x >= w || y >= h) continue;
      const ci = ((bits >>> (k * 2)) & 3) * 4, o = (y * w + x) * 4;
      out[o] = col[ci]; out[o + 1] = col[ci + 1]; out[o + 2] = col[ci + 2];
      let a = col[ci + 3];
      if (abits) a = al[(abits[k >> 3] >> ((k & 7) * 3)) & 7];
      else if (a3 !== null) a = ((data[a3 + (k >> 1)] >> ((k & 1) * 4)) & 15) * 17;
      out[o + 3] = a;
      if (a < 250) hasAlpha = true;
    }
  }
  return { width: w, height: h, data: out, hasAlpha };
}
