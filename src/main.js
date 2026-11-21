import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Terrain } from './terrain.js';
import { DEFAULT_SURFACES } from './surfaces.js';
import { ObjectManager, DEFAULT_LIBRARY } from './objects.js';
import { RoadManager } from './roads.js';
import { buildExportZip, parseASC } from './exporters.js';
import { saveProject, loadProject } from './project.js';
import { mulberry32 } from './noise.js';

// ======================================================================
// Scène
// ======================================================================
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color('#9db8cf');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 3000, 14000);

const camera = new THREE.PerspectiveCamera(55, 1, 1, 60000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.495;
controls.screenSpacePanning = false;

scene.add(new THREE.HemisphereLight('#dfeaff', '#4a4230', 1.3));
const sun = new THREE.DirectionalLight('#fff3dd', 2.2);
sun.position.set(-3000, 5000, -2000);
scene.add(sun);

const state = {
  settings: { radius: 60, strength: 0.5, falloff: 0.6 },
  tool: 'raise',
};

const terrain = new Terrain(scene, { gridSize: 513, cellSize: 10, maskRes: 1024, surfaces: DEFAULT_SURFACES.map((s) => ({ ...s })) });
const objects = new ObjectManager(scene, terrain);
const roads = new RoadManager(scene, terrain);
state.terrain = terrain; state.objects = objects; state.roads = roads;

// Mer (niveau 0, comme dans Arma 3)
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: '#2b6c8c', transparent: true, opacity: 0.78, roughness: 0.15, metalness: 0.1 }),
);
water.renderOrder = 1;
scene.add(water);

// Curseur du pinceau
const cursor = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false, transparent: true }));
cursor.renderOrder = 20;
cursor.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(65 * 3), 3));
scene.add(cursor);

function resetView() {
  const S = terrain.size;
  water.scale.set(S * 6, 1, S * 6);
  water.position.set(S / 2, 0, S / 2);
  controls.target.set(S / 2, 0, S / 2);
  camera.position.set(S / 2, S * 0.55, S * 1.25);
  scene.fog.near = S * 0.8; scene.fog.far = S * 3.5;
  controls.maxDistance = S * 3;
  controls.update();
}

// ======================================================================
// Annuler / Rétablir
// ======================================================================
const undoStack = [], redoStack = [];
function snapshot(kind) {
  const s = { kind };
  if (kind.includes('h')) s.heights = terrain.heights.slice();
  if (kind.includes('s')) s.surf = terrain.surf.slice();
  if (kind.includes('o')) s.objects = objects.objects.map((o) => ({ ...o }));
  if (kind.includes('r')) s.roads = JSON.parse(JSON.stringify(roads.roads));
  return s;
}
function pushUndo(kind) {
  undoStack.push(snapshot(kind));
  if (undoStack.length > 30) undoStack.shift();
  redoStack.length = 0;
  dirtyProject = true;
}
function restore(s) {
  if (s.heights) { terrain.heights.set(s.heights); terrain.updateHeights(0, 0, terrain.N - 1, terrain.N - 1); }
  if (s.surf) { terrain.surf.set(s.surf); terrain.redrawSurface(0, 0, terrain.maskRes - 1, terrain.maskRes - 1); }
  if (s.objects) objects.setObjects(s.objects.map((o) => ({ ...o })));
  if (s.roads) roads.roads = JSON.parse(JSON.stringify(s.roads));
  objects.refreshHeights();
  roads.rebuild();
  updateInfo();
}
function undo() { const s = undoStack.pop(); if (!s) return; redoStack.push(snapshot(s.kind)); restore(s); toast('Annulé'); }
function redo() { const s = redoStack.pop(); if (!s) return; undoStack.push(snapshot(s.kind)); restore(s); toast('Rétabli'); }

// ======================================================================
// Outils
// ======================================================================
const TOOLS = [
  { id: 'nav', icon: '✋', label: 'Vue' },
  { id: 'raise', icon: '⛰', label: 'Relief', undo: 'h' },
  { id: 'smooth', icon: '〰', label: 'Lisser', undo: 'h' },
  { id: 'flatten', icon: '▭', label: 'Aplanir', undo: 'h' },
  { id: 'water', icon: '🌊', label: 'Eau', undo: 'h' },
  { id: 'paint', icon: '🖌', label: 'Peindre', undo: 's' },
  { id: 'scatter', icon: '🌲', label: 'Forêt', undo: 'o' },
  { id: 'place', icon: '📦', label: 'Objet', undo: 'o' },
  { id: 'select', icon: '➚', label: 'Sélect.', undo: 'o' },
  { id: 'road', icon: '🛣', label: 'Routes', undo: 'rh' },
];

const toolSettings = {
  flattenLevel: 20,
  waterDepth: 4,
  surface: 0,
  paintHardness: 0.8,
  placeLib: 'house',
  placeRandomRot: true,
  scatter: {
    density: 250,     // arbres / hectare
    spacing: 4,       // distance mini (m)
    scaleMin: 0.8, scaleMax: 1.25,
    maxSlope: 35,
    avoidWater: true,
    species: { pine: 3, beech: 2, oak: 1, bush: 2 },
  },
  roadType: 1,
};

const toolsEl = document.getElementById('tools');
for (const t of TOOLS) {
  const b = document.createElement('button');
  b.dataset.tool = t.id;
  b.title = t.label;
  b.innerHTML = `${t.icon}<small>${t.label}</small>`;
  b.onclick = () => setTool(t.id);
  toolsEl.appendChild(b);
}

function setTool(id) {
  if (state.tool === 'road' && id !== 'road') roads.cancelDraft();
  state.tool = id;
  for (const b of toolsEl.children) b.classList.toggle('active', b.dataset.tool === id);
  controls.mouseButtons = {
    LEFT: id === 'nav' ? THREE.MOUSE.ROTATE : null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  if (id !== 'select') objects.select(null);
  if (id === 'road') roads.startDraft(toolSettings.roadType);
  renderPanel();
}

// ======================================================================
// Entrées souris
// ======================================================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hover = null;          // point du terrain sous la souris
let painting = false;
let shiftDown = false, ctrlDown = false;
let dragObj = null;
let lastFrame = performance.now();
let lastObjRefresh = 0;
let dirtyProject = false;

function updateHover(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  hover = terrain.raycast(raycaster.ray);
  updateStatus();
}

renderer.domElement.addEventListener('pointermove', (e) => {
  shiftDown = e.shiftKey; ctrlDown = e.ctrlKey || e.metaKey;
  updateHover(e);
  if (state.tool === 'road' && hover) roads.updateDraft(hover);
  if (dragObj && hover) objects.move(dragObj, hover.x, hover.z);
});

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.tool === 'nav') return;
  updateHover(e);
  if (!hover) return;
  const tool = TOOLS.find((t) => t.id === state.tool);

  if (state.tool === 'flatten' && (e.ctrlKey || e.metaKey)) {
    toolSettings.flattenLevel = Math.round(hover.y * 10) / 10;
    renderPanel();
    toast(`Niveau d'aplanissement : ${toolSettings.flattenLevel} m`);
    return;
  }
  if (state.tool === 'road') {
    roads.addDraftPoint(hover.x, hover.z);
    return;
  }
  if (state.tool === 'place') {
    pushUndo('o');
    const e2 = objects.entry(toolSettings.placeLib);
    if (!e2) return;
    objects.add({ lib: e2.id, x: hover.x, z: hover.z, rot: toolSettings.placeRandomRot ? Math.random() * Math.PI * 2 : 0, scale: 1 });
    updateInfo();
    return;
  }
  if (state.tool === 'select') {
    const o = objects.pick(hover.x, hover.z, Math.max(6, state.settings.radius * 0.15));
    objects.select(o);
    renderPanel();
    if (o) { pushUndo('o'); dragObj = o; }
    return;
  }
  if (tool?.undo) pushUndo(tool.undo);
  painting = true;
  renderer.domElement.setPointerCapture(e.pointerId);
});

window.addEventListener('pointerup', () => {
  if (painting) {
    painting = false;
    objects.refreshHeights();
    roads.rebuild();
    updateInfo();
  }
  dragObj = null;
});

renderer.domElement.addEventListener('dblclick', () => {
  if (state.tool === 'road') finishRoad();
});

function finishRoad() {
  const d = roads.draft;
  if (!d || d.points.length < 2) { toast('Une route a besoin d\'au moins 2 points'); return; }
  pushUndo('r');
  // Le double-clic ajoute deux fois le dernier point ; on le retire.
  const p = d.points;
  if (p.length > 2) {
    const a = p[p.length - 1], b = p[p.length - 2];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1) p.pop();
  }
  roads.finishDraft();
  roads.startDraft(toolSettings.roadType);
  renderPanel();
  updateInfo();
}

window.addEventListener('keydown', (e) => {
  shiftDown = e.shiftKey; ctrlDown = e.ctrlKey || e.metaKey;
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); doSave(); return; }
  if (k === '[') { state.settings.radius = Math.max(2, Math.round(state.settings.radius / 1.15)); renderPanel(); }
  if (k === ']') { state.settings.radius = Math.min(2000, Math.round(state.settings.radius * 1.15 + 1)); renderPanel(); }
  if (state.tool === 'road') {
    if (k === 'enter') finishRoad();
    if (k === 'escape') { roads.cancelDraft(); roads.startDraft(toolSettings.roadType); }
    if (k === 'backspace') roads.undoDraftPoint();
  }
  const sel = objects.selected;
  if (state.tool === 'select' && sel) {
    if (k === 'delete' || k === 'backspace') { pushUndo('o'); objects.remove([sel]); renderPanel(); updateInfo(); }
    if (k === 'r') { sel.rot += (e.shiftKey ? -1 : 1) * Math.PI / 12; objects.markDirty(sel.lib); }
    if (k === '+' || k === '=') { sel.scale = Math.min(5, sel.scale * 1.1); objects.markDirty(sel.lib); }
    if (k === '-') { sel.scale = Math.max(0.2, sel.scale / 1.1); objects.markDirty(sel.lib); }
  }
  const n = parseInt(e.key, 10);
  if (!e.ctrlKey && n >= 1 && n <= TOOLS.length && !e.altKey) setTool(TOOLS[n === 0 ? 9 : n - 1].id);
  if (e.key === '0') setTool(TOOLS[9].id);
});
window.addEventListener('keyup', (e) => { shiftDown = e.shiftKey; ctrlDown = e.ctrlKey || e.metaKey; });

// ======================================================================
// Application des pinceaux (à chaque image tant que le bouton est enfoncé)
// ======================================================================
function applyTool(dt) {
  if (!painting || !hover) return;
  const { radius: r, strength: st, falloff: fo } = state.settings;
  const { x, z } = hover;
  switch (state.tool) {
    case 'raise': {
      const sign = shiftDown ? -1 : 1;
      const rate = st * 30 * dt * sign;
      terrain.applyBrush(x, z, r, fo, (h, w) => h + rate * w);
      break;
    }
    case 'smooth':
      terrain.smoothBrush(x, z, r, fo, Math.min(1, st * dt * 12));
      break;
    case 'flatten': {
      const target = toolSettings.flattenLevel;
      const a = Math.min(1, st * dt * 8);
      terrain.applyBrush(x, z, r, fo, (h, w) => h + (target - h) * w * a);
      break;
    }
    case 'water': {
      // Creuse sous le niveau de la mer (0 m) avec des berges en pente douce.
      const target = -toolSettings.waterDepth;
      const a = Math.min(1, st * dt * 6);
      terrain.applyBrush(x, z, r, Math.max(fo, 0.4), (h, w) => (h > target ? h + (target - h) * w * a : h));
      break;
    }
    case 'paint':
      terrain.paintSurface(x, z, r, toolSettings.surface, toolSettings.paintHardness);
      break;
    case 'scatter':
      if (shiftDown) eraseObjects(x, z, r); else scatter(x, z, r);
      break;
  }
  const now = performance.now();
  if (['raise', 'smooth', 'flatten', 'water'].includes(state.tool) && now - lastObjRefresh > 300) {
    lastObjRefresh = now;
    objects.refreshHeights();
  }
}

const rng = mulberry32(Date.now() & 0xffffffff);
function scatterSpecies() {
  const sp = toolSettings.scatter.species;
  return Object.entries(sp).filter(([id, w]) => w > 0 && objects.entry(id));
}
function pickSpecies(list) {
  const tot = list.reduce((s, [, w]) => s + w, 0);
  let v = rng() * tot;
  for (const [id, w] of list) { v -= w; if (v <= 0) return id; }
  return list[list.length - 1][0];
}

function scatter(x, z, r) {
  const S = toolSettings.scatter;
  const list = scatterSpecies();
  if (!list.length) { toast('Choisis au moins une essence dans le panneau'); painting = false; return; }
  const ids = new Set(list.map(([id]) => id));
  const area = Math.PI * r * r;
  const target = Math.round((S.density * area) / 10000);
  const existing = objects.query(x, z, r).filter((o) => ids.has(o.lib)).length;
  let toAdd = Math.min(400, target - existing);
  let tries = toAdd * 4;
  while (toAdd > 0 && tries-- > 0) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    if (!terrain.inside(px, pz)) continue;
    const h = terrain.heightAt(px, pz);
    if (S.avoidWater && h < 0.5) continue;
    if (terrain.slopeAt(px, pz) > S.maxSlope) continue;
    if (objects.query(px, pz, S.spacing).length) continue;
    objects.add({
      lib: pickSpecies(list), x: px, z: pz,
      rot: rng() * Math.PI * 2,
      scale: S.scaleMin + rng() * (S.scaleMax - S.scaleMin),
    });
    toAdd--;
  }
}

function eraseObjects(x, z, r) {
  const ids = new Set(scatterSpecies().map(([id]) => id));
  const onlySpecies = toolSettings.scatter.eraseOnlySpecies;
  const victims = objects.query(x, z, r).filter((o) => !onlySpecies || ids.has(o.lib));
  if (victims.length) objects.remove(victims);
}

// ======================================================================
// Rendu
// ======================================================================
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function updateCursor() {
  const show = hover && !['nav', 'place', 'select', 'road'].includes(state.tool);
  cursor.visible = !!show;
  if (!show) return;
  const P = cursor.geometry.attributes.position;
  const r = state.settings.radius;
  for (let k = 0; k <= 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    const x = hover.x + Math.cos(a) * r, z = hover.z + Math.sin(a) * r;
    P.setXYZ(k, x, terrain.heightAt(x, z) + 1.5, z);
  }
  P.needsUpdate = true;
  cursor.geometry.computeBoundingSphere();
  const col = state.tool === 'scatter' && shiftDown ? 0xff5050 : state.tool === 'raise' && shiftDown ? 0x60b0ff : 0xffd400;
  cursor.material.color.setHex(col);
}

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  applyTool(dt);
  objects.flush();
  updateCursor();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// ======================================================================
// Panneau latéral
// ======================================================================
const panelTitle = document.getElementById('panel-title');
const panelBody = document.getElementById('panel-body');

function slider(label, get, set, min, max, step, unit = '') {
  const row = document.createElement('div');
  row.className = 'row';
  const v = get();
  row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${v}"><output>${v}${unit}</output>`;
  const inp = row.querySelector('input'), out = row.querySelector('output');
  inp.oninput = () => { set(parseFloat(inp.value)); out.textContent = inp.value + unit; };
  return row;
}
function numberRow(label, get, set, step = 1) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}</label><input type="number" step="${step}" value="${get()}">`;
  const inp = row.querySelector('input');
  inp.onchange = () => set(parseFloat(inp.value));
  return row;
}
function checkRow(label, get, set) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}</label><input type="checkbox" ${get() ? 'checked' : ''}>`;
  row.querySelector('input').onchange = (e) => set(e.target.checked);
  return row;
}
function h3(t) { const e = document.createElement('h3'); e.textContent = t; return e; }
function note(html) { const e = document.createElement('p'); e.className = 'note'; e.innerHTML = html; return e; }
function btn(label, fn, cls = '') { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; if (cls) b.className = cls; return b; }

function brushControls(withStrength = true, withFalloff = true) {
  const s = state.settings;
  panelBody.append(h3('Pinceau'));
  panelBody.append(slider('Rayon (m)', () => s.radius, (v) => (s.radius = v), 2, 1000, 1));
  if (withStrength) panelBody.append(slider('Force', () => s.strength, (v) => (s.strength = v), 0.02, 1, 0.01));
  if (withFalloff) panelBody.append(slider('Douceur du bord', () => s.falloff, (v) => (s.falloff = v), 0, 1, 0.05));
}

function libraryList(onPick, activeId, withWeights = false) {
  const list = document.createElement('div');
  list.className = 'list';
  for (const e of objects.library) {
    const it = document.createElement('div');
    it.className = 'item' + (e.id === activeId ? ' active' : '');
    const w = toolSettings.scatter.species[e.id] || 0;
    it.innerHTML = `<span class="sw" style="background:${e.color || '#888'}"></span>
      <div class="grow"><div>${esc(e.name)}</div><div class="sub">${esc(e.tbName || '')}</div></div>`;
    if (withWeights) {
      const r = document.createElement('input');
      r.type = 'range'; r.min = 0; r.max = 5; r.step = 1; r.value = w;
      r.title = 'Proportion dans le mélange';
      const o = document.createElement('output'); o.textContent = w;
      r.oninput = () => { toolSettings.scatter.species[e.id] = +r.value; o.textContent = r.value; };
      r.onclick = (ev) => ev.stopPropagation();
      it.append(r, o);
    } else it.onclick = () => onPick(e.id);
    list.append(it);
  }
  return list;
}

function renderPanel() {
  const t = TOOLS.find((x) => x.id === state.tool);
  panelTitle.textContent = `${t.icon} ${t.label}`;
  panelBody.innerHTML = '';
  switch (state.tool) {
    case 'nav':
      panelBody.append(note('Clic gauche ou droit : tourner autour du terrain. Clic molette : déplacer la vue. Molette : zoom.'));
      panelBody.append(h3('Terrain'));
      panelBody.append(note(`${terrain.size} m × ${terrain.size} m, grille ${terrain.N} × ${terrain.N}, ${terrain.cell} m par cellule.`));
      panelBody.append(btn('Recentrer la vue', resetView));
      panelBody.append(h3('Affichage'));
      panelBody.append(checkRow('Afficher la mer', () => water.visible, (v) => (water.visible = v)));
      panelBody.append(checkRow('Afficher les objets', () => objects.root.visible, (v) => (objects.root.visible = v)));
      panelBody.append(checkRow('Fil de fer', () => terrain.mesh.material.wireframe, (v) => (terrain.mesh.material.wireframe = v)));
      break;
    case 'raise':
      panelBody.append(note('Maintiens le clic gauche pour <b>élever</b> le terrain. Maintiens <b>Maj</b> pour <b>abaisser</b>.'));
      brushControls();
      break;
    case 'smooth':
      panelBody.append(note('Adoucit les bosses et les arêtes sous le pinceau.'));
      brushControls();
      break;
    case 'flatten':
      panelBody.append(note('Amène le terrain au niveau choisi. <b>Ctrl+clic</b> sur le terrain pour prendre son altitude.'));
      panelBody.append(numberRow('Niveau (m)', () => toolSettings.flattenLevel, (v) => (toolSettings.flattenLevel = v), 0.5));
      brushControls();
      break;
    case 'water':
      panelBody.append(note('Creuse un plan d\'eau sous le niveau de la mer (0 m). Dans Arma 3, toute zone sous 0 m est de l\'eau : mer, baies, étangs reliés ou non.'));
      panelBody.append(numberRow('Profondeur (m)', () => toolSettings.waterDepth, (v) => (toolSettings.waterDepth = Math.max(0.5, v)), 0.5));
      brushControls();
      panelBody.append(note('Les lacs <i>au-dessus</i> du niveau de la mer ne sont pas gérés nativement par Arma 3 (il faut des objets d\'eau de mods).'));
      break;
    case 'paint': {
      panelBody.append(note('Peins le type de sol. Il sert au masque de surface (sons, herbe, textures au sol) et à l\'image satellite.'));
      const list = document.createElement('div');
      list.className = 'list';
      terrain.surfaces.forEach((s, i) => {
        const it = document.createElement('div');
        it.className = 'item' + (i === toolSettings.surface ? ' active' : '');
        it.innerHTML = `<span class="sw" style="background:rgb(${s.sat})"></span><div class="grow">${esc(s.name)}<div class="sub">masque rgb(${s.mask})</div></div>`;
        it.onclick = () => { toolSettings.surface = i; renderPanel(); };
        list.append(it);
      });
      panelBody.append(h3('Surface'), list);
      brushControls(false, false);
      panelBody.append(slider('Netteté du bord', () => toolSettings.paintHardness, (v) => (toolSettings.paintHardness = v), 0.3, 1, 0.05));
      break;
    }
    case 'scatter': {
      const S = toolSettings.scatter;
      panelBody.append(note('Peins une forêt ou une zone de végétation. Règle le <b>mélange d\'essences</b> avec les curseurs (0 = absent). Maintiens <b>Maj</b> pour gommer.'));
      panelBody.append(h3('Mélange'), libraryList(null, null, true));
      panelBody.append(h3('Répartition'));
      panelBody.append(slider('Densité (/ha)', () => S.density, (v) => (S.density = v), 5, 800, 5));
      panelBody.append(slider('Espacement min (m)', () => S.spacing, (v) => (S.spacing = v), 1, 30, 0.5));
      panelBody.append(slider('Échelle min', () => S.scaleMin, (v) => (S.scaleMin = Math.min(v, S.scaleMax)), 0.3, 2, 0.05));
      panelBody.append(slider('Échelle max', () => S.scaleMax, (v) => (S.scaleMax = Math.max(v, S.scaleMin)), 0.3, 2.5, 0.05));
      panelBody.append(slider('Pente max (°)', () => S.maxSlope, (v) => (S.maxSlope = v), 5, 90, 1));
      panelBody.append(checkRow('Éviter l\'eau', () => S.avoidWater, (v) => (S.avoidWater = v)));
      panelBody.append(checkRow('Gomme : essences du mélange seulement', () => !!S.eraseOnlySpecies, (v) => (S.eraseOnlySpecies = v)));
      brushControls(false, false);
      break;
    }
    case 'place':
      panelBody.append(note('Clique sur le terrain pour poser l\'objet choisi. Utilise l\'outil Sélection pour le déplacer ou le tourner.'));
      panelBody.append(checkRow('Rotation aléatoire', () => toolSettings.placeRandomRot, (v) => (toolSettings.placeRandomRot = v)));
      panelBody.append(h3('Bibliothèque'), libraryList((id) => { toolSettings.placeLib = id; renderPanel(); }, toolSettings.placeLib));
      libraryTools();
      break;
    case 'select': {
      panelBody.append(note('Clique un objet pour le sélectionner, fais-le glisser pour le déplacer.<br><b>R</b> / <b>Maj+R</b> : tourner · <b>+</b> / <b>-</b> : taille · <b>Suppr</b> : supprimer.'));
      const o = objects.selected;
      if (o) {
        const e = objects.entry(o.lib);
        panelBody.append(h3('Objet sélectionné'));
        panelBody.append(note(`${esc(e?.name || o.lib)} (${esc(e?.tbName || '')})`));
        panelBody.append(slider('Rotation (°)', () => Math.round(((-o.rot * 180) / Math.PI % 360 + 360) % 360), (v) => { o.rot = (-v * Math.PI) / 180; objects.markDirty(o.lib); }, 0, 359, 1));
        panelBody.append(slider('Échelle', () => +o.scale.toFixed(2), (v) => { o.scale = v; objects.markDirty(o.lib); }, 0.2, 4, 0.05));
        panelBody.append(slider('Décalage vertical (m)', () => o.dy || 0, (v) => { o.dy = v; objects.markDirty(o.lib); }, -5, 5, 0.1));
        panelBody.append(btn('Supprimer', () => { pushUndo('o'); objects.remove([o]); renderPanel(); updateInfo(); }, 'danger'));
      }
      break;
    }
    case 'road': {
      panelBody.append(note('Clique pour ajouter des points. <b>Double-clic</b> ou <b>Entrée</b> pour terminer la route. <b>Retour arrière</b> : retirer le dernier point. <b>Échap</b> : annuler.'));
      const sel = document.createElement('div');
      sel.className = 'row';
      sel.innerHTML = `<label>Type</label><select>${roads.types.map((t) => `<option value="${t.id}" ${t.id === toolSettings.roadType ? 'selected' : ''}>${esc(t.name)} (${t.width} m)</option>`).join('')}</select>`;
      sel.querySelector('select').onchange = (e) => {
        toolSettings.roadType = +e.target.value;
        if (roads.draft) roads.draft.type = toolSettings.roadType;
      };
      panelBody.append(sel);
      panelBody.append(btn('Terminer la route', finishRoad));
      panelBody.append(h3(`Routes (${roads.roads.length})`));
      const list = document.createElement('div');
      list.className = 'list';
      roads.roads.forEach((r, i) => {
        const t2 = roads.type(r.type);
        const it = document.createElement('div');
        it.className = 'item';
        it.innerHTML = `<span class="sw" style="background:${t2.color}"></span><div class="grow">Route ${i + 1}<div class="sub">${esc(t2.name)} · ${r.points.length} points</div></div>`;
        it.append(btn('✕', () => { pushUndo('r'); roads.roads.splice(i, 1); roads.rebuild(); renderPanel(); updateInfo(); }, 'small danger'));
        list.append(it);
      });
      panelBody.append(list);
      panelBody.append(h3('Terrain'));
      panelBody.append(btn('Aplanir le terrain sous les routes', () => {
        pushUndo('h');
        roads.flattenUnder();
        objects.refreshHeights();
        roads.rebuild();
        toast('Terrain nivelé sous les routes');
      }));
      break;
    }
  }
}

function libraryTools() {
  panelBody.append(h3('Importer un modèle'));
  panelBody.append(note('Formats : GLB, GLTF (fichier unique), OBJ. Le modèle sert d\'aperçu ; indique le nom du modèle Arma tel qu\'il est dans ta bibliothèque Terrain Builder.'));
  panelBody.append(btn('Importer un modèle 3D…', importModel));
  const e = objects.entry(toolSettings.placeLib);
  if (e) {
    panelBody.append(h3('Modèle choisi'));
    const nm = document.createElement('div'); nm.className = 'row';
    nm.innerHTML = `<label>Nom affiché</label><input type="text" value="${esc(e.name)}">`;
    nm.querySelector('input').onchange = (ev) => { e.name = ev.target.value; renderPanel(); };
    const tb = document.createElement('div'); tb.className = 'row';
    tb.innerHTML = `<label>Nom Terrain Builder</label><input type="text" value="${esc(e.tbName || '')}">`;
    tb.querySelector('input').onchange = (ev) => { e.tbName = ev.target.value.trim(); renderPanel(); };
    panelBody.append(nm, tb);
    panelBody.append(btn('Retirer de la bibliothèque', () => {
      if (!confirmBox(`Retirer « ${e.name} » et tous ses objets placés ?`)) return;
      pushUndo('o');
      objects.removeLibraryEntry(e.id);
      delete toolSettings.scatter.species[e.id];
      toolSettings.placeLib = objects.library[0]?.id;
      renderPanel(); updateInfo();
    }, 'danger'));
  }
}

function confirmBox(msg) { return window.confirm(msg); }

async function importModel() {
  const file = await pickFile('.glb,.gltf,.obj');
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
  const base = file.name.replace(/\.[^.]+$/, '');
  const values = await formDialog('Nouveau modèle', [
    { key: 'name', label: 'Nom affiché', value: base },
    { key: 'tbName', label: 'Nom Terrain Builder', value: base },
    { key: 'scale', label: 'Échelle du modèle', value: 1, type: 'number', step: 0.01 },
  ], 'Le nom Terrain Builder doit correspondre au modèle (p3d) que tu as dans ta bibliothèque TB, par ex. « Land_MaMaison_01 ».');
  if (!values) return;
  try {
    const id = 'm_' + Date.now().toString(36);
    const entry = await objects.addLibraryEntry({
      id, name: values.name, tbName: values.tbName, color: '#c08040',
      modelData: dataUrl, modelFormat: ext === 'obj' ? 'obj' : 'gltf', modelScale: +values.scale || 1,
    });
    const s = entry.modelScale;
    if (s !== 1) for (const p of objects.groups.get(id).parts) p.matrix.premultiply(new THREE.Matrix4().makeScale(s, s, s));
    entry.height = (entry.height || 5) * s;
    toolSettings.placeLib = id;
    renderPanel();
    toast(`Modèle « ${values.name} » ajouté`);
  } catch (err) {
    console.error(err);
    alertDialog('Import impossible', `Le fichier n'a pas pu être lu : ${esc(err.message || err)}. Pour un GLTF, utilise plutôt un GLB (fichier unique avec textures intégrées).`);
  }
}

// ======================================================================
// Boîtes de dialogue
// ======================================================================
const dlg = document.getElementById('dlg');
const dlgForm = document.getElementById('dlg-form');

function formDialog(title, fields, intro = '', okLabel = 'Valider') {
  return new Promise((resolve) => {
    dlgForm.innerHTML = `<h2>${title}</h2>${intro ? `<p class="note">${intro}</p>` : ''}` +
      fields.map((f) => {
        if (f.type === 'select')
          return `<div class="row"><label>${f.label}</label><select name="${f.key}">${f.options.map(([v, l]) => `<option value="${v}" ${String(v) === String(f.value) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
        if (f.type === 'checkbox')
          return `<div class="row"><label>${f.label}</label><input type="checkbox" name="${f.key}" ${f.value ? 'checked' : ''}></div>`;
        return `<div class="row"><label>${f.label}</label><input name="${f.key}" type="${f.type || 'text'}" step="${f.step || 'any'}" value="${esc(String(f.value))}"></div>`;
      }).join('') +
      `<menu><button value="cancel" formnovalidate>Annuler</button><button value="ok" class="primary">${okLabel}</button></menu>`;
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const out = {};
      for (const f of fields) {
        const el = dlgForm.elements[f.key];
        out[f.key] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? parseFloat(el.value) : el.value;
      }
      resolve(out);
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function alertDialog(title, html) {
  return new Promise((resolve) => {
    dlgForm.innerHTML = `<h2>${title}</h2><div>${html}</div><menu><button value="ok" class="primary">OK</button></menu>`;
    dlg.onclose = () => resolve();
    dlg.showModal();
  });
}

const fileInput = document.getElementById('file-input');
function pickFile(accept) {
  return new Promise((resolve) => {
    fileInput.accept = accept;
    fileInput.value = '';
    fileInput.onchange = () => resolve(fileInput.files[0] || null);
    fileInput.click();
  });
}

function download(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ======================================================================
// Menu principal
// ======================================================================
async function doNew() {
  const v = await formDialog('Nouveau terrain', [
    { key: 'grid', label: 'Grille d\'altitude', type: 'select', value: 513, options: [[257, '256 × 256'], [513, '512 × 512'], [1025, '1024 × 1024'], [2049, '2048 × 2048 (lourd)']] },
    { key: 'cell', label: 'Taille de cellule (m)', type: 'number', value: 10, step: 0.5 },
    { key: 'mask', label: 'Résolution sat/masque', type: 'select', value: 1024, options: [[1024, '1024 px'], [2048, '2048 px'], [4096, '4096 px (lourd)']] },
    { key: 'relief', label: 'Relief de départ', type: 'select', value: 'island', options: [['island', 'Île générée'], ['hills', 'Collines générées'], ['flat', 'Plat (10 m)']] },
    { key: 'seed', label: 'Graine (variante)', type: 'number', value: Math.floor(Math.random() * 9999) },
  ], 'Taille du terrain = (grille − 1) × cellule. Exemple : 512 × 10 m = 5,12 km.', 'Créer');
  if (!v) return;
  if (dirtyProject && !confirmBox('Les modifications non enregistrées seront perdues. Continuer ?')) return;
  const keepObjects = objects.library;
  terrain.init(+v.grid, +v.cell || 10, +v.mask);
  if (v.relief === 'flat') terrain.flatAll(10);
  else terrain.generate({ seed: +v.seed || 1, amplitude: 140, island: v.relief === 'island' });
  autoPaint();
  objects.setObjects([]);
  objects.library = keepObjects;
  roads.roads = []; roads.rebuild();
  undoStack.length = redoStack.length = 0;
  dirtyProject = false;
  resetView(); renderPanel(); updateInfo();
}

// Peinture automatique de départ : sable près de l'eau, roche sur les pentes.
function autoPaint() {
  const R = terrain.maskRes;
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const wx = (x / (R - 1)) * terrain.size, wz = (y / (R - 1)) * terrain.size;
      const h = terrain.heightAt(wx, wz);
      const sl = terrain.slopeAt(wx, wz);
      let s = 0;
      if (h < 2.5) s = 4;
      else if (sl > 32) s = 5;
      else if (sl > 22) s = 3;
      else if (h > 120) s = 1;
      terrain.surf[y * R + x] = s;
    }
  terrain.redrawSurface(0, 0, R - 1, R - 1);
}

async function doSave() {
  const bytes = saveProject(state);
  download(bytes, 'mon_terrain.tfa3');
  dirtyProject = false;
  toast('Projet enregistré (fichier .tfa3)');
}

async function doOpen() {
  const f = await pickFile('.tfa3');
  if (!f) return;
  try {
    const { json, heights, surf } = loadProject(new Uint8Array(await f.arrayBuffer()));
    terrain.surfaces = json.surfaces;
    terrain.init(json.gridSize, json.cellSize, json.maskRes);
    terrain.heights.set(heights);
    terrain.updateHeights(0, 0, terrain.N - 1, terrain.N - 1);
    terrain.surf.set(surf);
    terrain.redrawSurface(0, 0, terrain.maskRes - 1, terrain.maskRes - 1);
    await objects.setLibrary(json.library);
    objects.setObjects(json.objects);
    roads.types = json.roadTypes || roads.types;
    roads.roads = json.roads || [];
    roads.rebuild();
    if (json.settings) Object.assign(state.settings, json.settings);
    undoStack.length = redoStack.length = 0;
    dirtyProject = false;
    resetView(); renderPanel(); updateInfo();
    toast('Projet chargé');
  } catch (err) {
    console.error(err);
    alertDialog('Ouverture impossible', esc(err.message || String(err)));
  }
}

async function doImportHeightmap() {
  const f = await pickFile('.asc,.png,.jpg,.jpeg');
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.asc')) {
    const { data, w, h, cellsize } = parseASC(await f.text());
    const keep = await formDialog('Importer un relief ASC', [
      { key: 'resize', label: 'Adapter la grille au fichier', type: 'checkbox', value: w <= 2049 && w === h },
    ], `Fichier : ${w} × ${h} points, ${cellsize} m par cellule.`);
    if (!keep) return;
    pushUndo('h');
    if (keep.resize && w === h) { terrain.init(w, cellsize || terrain.cell, terrain.maskRes); objects.refreshHeights(); resetView(); }
    terrain.loadHeightGrid(data, w, h);
  } else {
    const v = await formDialog('Importer une image de relief', [
      { key: 'min', label: 'Altitude du noir (m)', type: 'number', value: -20 },
      { key: 'max', label: 'Altitude du blanc (m)', type: 'number', value: 300 },
    ], 'Image en niveaux de gris : noir = point le plus bas, blanc = point le plus haut.');
    if (!v) return;
    const img = await createImageBitmap(f);
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const data = new Float32Array(c.width * c.height);
    for (let i = 0; i < data.length; i++) data[i] = v.min + (d[i * 4] / 255) * (v.max - v.min);
    pushUndo('h');
    terrain.loadHeightGrid(data, c.width, c.height);
  }
  objects.refreshHeights(); roads.rebuild(); updateInfo();
  toast('Relief importé');
}

async function doExport() {
  const v = await formDialog('Exporter vers Terrain Builder', [
    { key: 'tag', label: 'Nom du mod / dossier', value: 'monterrain' },
    { key: 'offsetEast', label: 'Easting (décalage X)', type: 'number', value: 200000 },
    { key: 'offsetNorth', label: 'Northing (décalage Y)', type: 'number', value: 0 },
    { key: 'imageScale', label: 'Agrandir sat/masque', type: 'select', value: 1, options: [[1, `×1 (${terrain.maskRes} px)`], [2, `×2 (${terrain.maskRes * 2} px)`], [4, `×4 (${terrain.maskRes * 4} px)`]] },
    { key: 'xyz', label: 'Ajouter aussi un fichier XYZ', type: 'checkbox', value: false },
  ], 'Crée un .zip avec le relief (ASC), le masque et l\'image satellite (PNG), layers.cfg, la liste des objets (TXT), les routes (shapefile + RoadsLib.cfg) et un mode d\'emploi.', 'Exporter');
  if (!v) return;
  toast('Export en cours…', 8000);
  await new Promise((r) => setTimeout(r, 50));
  try {
    const zip = await buildExportZip(state, { ...v, imageScale: +v.imageScale });
    download(zip, `${v.tag || 'terrain'}_terrainbuilder.zip`, 'application/zip');
    toast('Export terminé');
  } catch (err) {
    console.error(err);
    alertDialog('Export impossible', esc(err.message || String(err)));
  }
}

function doHelp() {
  alertDialog('Aide TerraForge A3', `
  <ul>
    <li><b>Vue</b> : clic droit pour tourner, clic molette pour déplacer, molette pour zoomer.</li>
    <li><b>Touches 1 à 9, 0</b> : changer d'outil. <b>[ ]</b> : taille du pinceau. <b>Ctrl+Z / Ctrl+Y</b> : annuler / rétablir. <b>Ctrl+S</b> : enregistrer.</li>
    <li><b>Relief</b> : clic pour monter, Maj+clic pour descendre. <b>Aplanir</b> : Ctrl+clic pour prendre l'altitude.</li>
    <li><b>Forêt</b> : règle le mélange d'essences, la densité et l'échelle, puis peins. Maj pour gommer.</li>
    <li><b>Routes</b> : clic pour poser des points, double-clic pour terminer.</li>
    <li><b>Exporter</b> produit un .zip prêt à importer dans Terrain Builder ; le fichier LISEZMOI.txt explique chaque étape.</li>
  </ul>
  <p class="note">La compilation finale du terrain (WRP + PBO) se fait toujours avec les outils Arma 3 (Terrain Builder, Addon Builder ou pboProject).</p>`);
}

document.getElementById('topbar').addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.action;
  ({ new: doNew, open: doOpen, save: doSave, 'import-hm': doImportHeightmap, export: doExport, undo, redo, help: doHelp })[a]?.();
});
window.addEventListener('beforeunload', (e) => { if (dirtyProject) { e.preventDefault(); e.returnValue = ''; } });

// ======================================================================
// Barre d'état
// ======================================================================
const stPos = document.getElementById('st-pos');
const stInfo = document.getElementById('st-info');
function updateStatus() {
  if (!hover) { stPos.textContent = '—'; return; }
  stPos.textContent = `X ${hover.x.toFixed(0)}  Y ${(terrain.size - hover.z).toFixed(0)}  Alt. ${hover.y.toFixed(1)} m  Pente ${terrain.slopeAt(hover.x, hover.z).toFixed(0)}°`;
}
function updateInfo() {
  stInfo.textContent = `${objects.objects.length.toLocaleString('fr-FR')} objets · ${roads.roads.length} routes`;
}

let toastTimer;
const toastEl = document.createElement('div');
toastEl.id = 'toast';
viewport.append(toastEl);
function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ======================================================================
// Démarrage
// ======================================================================
(async function start() {
  terrain.generate({ seed: 7, amplitude: 140, island: true });
  autoPaint();
  await objects.setLibrary(DEFAULT_LIBRARY.map((e) => ({ ...e })));
  resize();
  resetView();
  setTool('raise');
  updateInfo();
  loop();
  window.__tf = state; // pratique pour le débogage dans la console
})();
