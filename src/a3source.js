import { parsePaaHeader, decodePaaMip } from './paa.js';

// Source des modèles Arma 3 choisie par l'utilisateur : fichiers .pbo et/ou
// dossiers contenant des .p3d / .paa (lecteur P:, dossier de mod, Addons…).
// Rien n'est copié : on garde des références vers les fichiers et on lit à la demande.
const norm = (p) => p.replace(/\//g, '\\').replace(/^\\+/, '').toLowerCase();

async function readRange(file, off, size) {
  return new Uint8Array(await file.slice(off, off + size).arrayBuffer());
}

// Lit la table des fichiers d'un .pbo sans charger le fichier entier.
export async function readPboIndex(file) {
  let chunk = 1 << 18;
  for (;;) {
    const u8 = await readRange(file, 0, Math.min(chunk, file.size));
    const dv = new DataView(u8.buffer);
    let p = 0, complete = false, first = true;
    const entries = [], props = {};
    const str = () => { let e = p; while (e < u8.length && u8[e] !== 0) e++; if (e >= u8.length) throw new RangeError(); let s = ''; for (let i = p; i < e; i++) s += String.fromCharCode(u8[i]); p = e + 1; return s; };
    try {
      for (;;) {
        const name = str();
        if (p + 20 > u8.length) throw new RangeError();
        const method = dv.getUint32(p, true), size = dv.getUint32(p + 16, true);
        p += 20;
        if (first && name === '' && method === 0x56657273) {
          for (;;) { const k = str(); if (!k) break; props[k] = str(); }
          first = false; continue;
        }
        first = false;
        if (name === '') { complete = true; break; }
        entries.push({ name, method, size });
      }
    } catch (e) { if (!(e instanceof RangeError)) throw e; }
    if (complete) {
      let off = p;
      for (const e of entries) { e.off = off; off += e.size; }
      return { entries, prefix: props.prefix || file.name.replace(/\.pbo$/i, '') };
    }
    if (chunk >= file.size || chunk > (1 << 28)) throw new Error('fichier .pbo illisible');
    chunk *= 4;
  }
}

export class A3Source {
  constructor() {
    this.files = new Map();   // chemin normalisé -> { file, off, size }
    this.models = [];         // { key, name, group }
    this.byName = new Map();  // nom de modèle (sans .p3d) -> key
    this.suffix = new Map();  // "dossier\fichier" -> [key] (pour les dossiers libres)
    this.labels = [];         // sources ajoutées (affichage)
  }

  get count() { return this.models.length; }

  _add(key, ref, group, loose) {
    if (this.files.has(key)) { this.files.set(key, ref); return; }
    this.files.set(key, ref);
    if (loose) {
      const parts = key.split('\\');
      const sk = parts.slice(-2).join('\\');
      let a = this.suffix.get(sk);
      if (!a) this.suffix.set(sk, (a = []));
      a.push(key);
    }
    if (key.endsWith('.p3d')) {
      const base = key.slice(key.lastIndexOf('\\') + 1, -4);
      this.models.push({ key, name: ref.display || base, group });
      if (!this.byName.has(base)) this.byName.set(base, key);
    }
  }

  async addPbo(file) {
    const { entries, prefix } = await readPboIndex(file);
    const pre = norm(prefix);
    let n = 0;
    for (const e of entries) {
      if (e.method !== 0) continue; // entrées compressées : rares, ignorées
      const low = e.name.toLowerCase();
      if (!low.endsWith('.p3d') && !low.endsWith('.paa')) continue;
      const display = e.name.slice(e.name.lastIndexOf('\\') + 1).replace(/\.p3d$/i, '');
      this._add(norm(pre + '\\' + e.name), { file, off: e.off, size: e.size, display }, pre, false);
      if (low.endsWith('.p3d')) n++;
    }
    this.labels.push(file.name);
    return n;
  }

  // Fichiers d'un dossier choisi (File avec webkitRelativePath) ou fichiers isolés.
  async addFiles(fileList, progress) {
    let models = 0, pbos = 0, i = 0;
    const list = [...fileList];
    for (const f of list) {
      i++;
      const low = f.name.toLowerCase();
      const rel = f.webkitRelativePath || f.name;
      try {
        if (low.endsWith('.pbo')) {
          if (progress) await progress(`Lecture de ${f.name} (${i}/${list.length})`);
          models += await this.addPbo(f); pbos++;
        } else if (low.endsWith('.p3d') || low.endsWith('.paa')) {
          const key = norm(rel);
          const group = key.includes('\\') ? key.slice(0, key.lastIndexOf('\\')) : '(fichiers)';
          this._add(key, { file: f, off: 0, size: f.size, display: f.name.replace(/\.p3d$/i, '') }, group.split('\\').slice(0, 3).join('\\'), true);
          if (low.endsWith('.p3d')) models++;
        }
      } catch (e) { console.warn('Source ignorée :', f.name, e); }
    }
    if (list.length && !pbos) this.labels.push((list[0].webkitRelativePath || list[0].name).split('/')[0]);
    this.models.sort((a, b) => a.name.localeCompare(b.name));
    return { models, pbos };
  }

  resolve(path) {
    if (!path) return null;
    const key = norm(path);
    if (this.files.has(key)) return key;
    const parts = key.split('\\');
    const cands = this.suffix.get(parts.slice(-2).join('\\'));
    if (cands) {
      let best = null, bl = 0;
      for (const c of cands) {
        const cp = c.split('\\');
        let n = 0;
        while (n < cp.length && n < parts.length && cp[cp.length - 1 - n] === parts[parts.length - 1 - n]) n++;
        if (n > bl) { bl = n; best = c; }
      }
      return best;
    }
    return null;
  }

  async read(key, off = 0, size = Infinity) {
    const r = this.files.get(key);
    if (!r) throw new Error('fichier introuvable : ' + key);
    const n = Math.min(size, r.size - off);
    return readRange(r.file, r.off + off, n);
  }

  // Décode une texture .paa à une taille raisonnable ; null si absente ou illisible.
  async image(path, maxSize = 512) {
    const key = this.resolve(path);
    if (!key) return null;
    try {
      const size = this.files.get(key).size;
      const head = await this.read(key, 0, 2048);
      const h = parsePaaHeader(head);
      let k = 0;
      while (k < h.offsets.length - 1 && (Math.max(h.width, h.height) >> k) > maxSize) k++;
      const start = h.offsets[k], end = k + 1 < h.offsets.length ? h.offsets[k + 1] : size;
      const mip = decodePaaMip(h.type, await this.read(key, start, end - start));
      mip.alphaFlag = h.alphaFlag;
      return mip;
    } catch (e) { console.warn('Texture illisible :', path, e); return null; }
  }
}
