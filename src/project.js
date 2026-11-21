import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

// Fichier projet .tfa3 = zip contenant project.json + heights.bin + surf.bin
export function saveProject(state, satBytes) {
  const { terrain: T, objects: O, roads: R } = state;
  const json = {
    format: 'terraforge-a3',
    version: 1,
    gridSize: T.N,
    cellSize: T.cell,
    maskRes: T.maskRes,
    surfaces: T.surfaces,
    library: O.library.map((e) => { const c = { ...e }; delete c._missing; return c; }),
    objects: O.objects.map((o) => [o.lib, round(o.x), round(o.z), round(o.rot, 4), round(o.scale, 3), o.dy || 0, ...(o.rx || o.rz ? [round(o.rx || 0, 4), round(o.rz || 0, 4)] : [])]),
    roadTypes: R.types,
    roads: R.roads,
    settings: state.settings,
  };
  const files = {
    'project.json': strToU8(JSON.stringify(json)),
    'heights.bin': new Uint8Array(T.heights.buffer.slice(0)),
    'surf.bin': T.surf,
  };
  if (satBytes) files['sat.jpg'] = satBytes;
  return zipSync(files, { level: 3 });
}

export function loadProject(bytes) {
  const files = unzipSync(bytes);
  const json = JSON.parse(strFromU8(files['project.json']));
  if (json.format !== 'terraforge-a3') throw new Error('Fichier projet non reconnu');
  const heights = new Float32Array(files['heights.bin'].slice().buffer);
  const surf = files['surf.bin'];
  json.objects = json.objects.map(([lib, x, z, rot, scale, dy, rx, rz]) => ({ lib, x, z, rot, scale, dy, ...(rx || rz ? { rx: rx || 0, rz: rz || 0 } : {}) }));
  return { json, heights, surf, sat: files['sat.jpg'] || null };
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
