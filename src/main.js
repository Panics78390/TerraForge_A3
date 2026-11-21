import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Terrain } from './terrain.js';
import { DEFAULT_SURFACES } from './surfaces.js';
import { ObjectManager, DEFAULT_LIBRARY, CATEGORIES, thumbnail, clearThumb, renderThumb } from './objects.js';
import { A3Source } from './a3source.js';
import { loadP3DParts, disposeParts, guessCategory } from './a3models.js';
import { RoadManager } from './roads.js';
import { buildExportZip, parseASC, canvasToJPEG } from './exporters.js';
import { saveProject, loadProject } from './project.js';
import { mulberry32, makeNoise } from './noise.js';
import { openWizard, LOGO } from './wizard.js';
import { generate, defaultParams } from './gen.js';
import { openGeoDialog, fetchElevation, fetchOSM, fetchSatellite, parseOSM, rasterizeAreas } from './geo.js';
import { SURFACE_SETS } from './surfaces.js';

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
  settings: { radius: 60, strength: 0.5, falloff: 0.6, name: 'MonTerrain', author: '' },
  tool: 'raise',
};

const terrain = new Terrain(scene, { gridSize: 512, cellSize: 8, maskRes: 1024, surfaces: DEFAULT_SURFACES.map((s) => ({ ...s })) });
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
  const y0 = Math.max(0, terrain.heightAt(S / 2, S / 2));
  controls.target.set(S / 2, y0, S / 2);
  camera.position.set(S / 2, y0 + S * 0.55, S * 1.25);
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
  // Limite la mémoire : une grille 2048 pèse 16 Mo par étape d'annulation.
  const maxUndo = Math.max(3, Math.min(30, Math.floor(250e6 / (terrain.heights.byteLength + terrain.surf.byteLength))));
  while (undoStack.length > maxUndo) undoStack.shift();
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
  renderAssets();
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
      if (terrain.sat) panelBody.append(checkRow('Image satellite réelle', () => terrain.showSat, (v) => terrain.setShowSat(v)));
      panelBody.append(btn('Importer ma propre image satellite…', importSatImage));
      panelBody.append(note('Image carrée couvrant toute la carte, le nord en haut (PNG ou JPG).'));
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
      panelBody.append(note('Choisis le modèle dans le <b>catalogue en bas de l\'écran</b>.'));
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
      roads.roads.slice(0, 150).forEach((r, i) => {
        const t2 = roads.type(r.type);
        const it = document.createElement('div');
        it.className = 'item';
        it.innerHTML = `<span class="sw" style="background:${t2.color}"></span><div class="grow">Route ${i + 1}<div class="sub">${esc(t2.name)} · ${r.points.length} points</div></div>`;
        it.append(btn('✕', () => { pushUndo('r'); roads.roads.splice(i, 1); roads.rebuild(); renderPanel(); updateInfo(); }, 'small danger'));
        list.append(it);
      });
      panelBody.append(list);
      if (roads.roads.length > 150) panelBody.append(note(`… et ${roads.roads.length - 150} autres routes.`));
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
  const e = objects.entry(toolSettings.placeLib);
  if (e) {
    panelBody.append(h3('Modèle choisi'));
    const nm = document.createElement('div'); nm.className = 'row';
    nm.innerHTML = `<label>Nom affiché</label><input type="text" value="${esc(e.name)}">`;
    nm.querySelector('input').onchange = (ev) => { e.name = ev.target.value; renderPanel(); renderAssets(); };
    const tb = document.createElement('div'); tb.className = 'row';
    tb.innerHTML = `<label>Nom Terrain Builder</label><input type="text" value="${esc(e.tbName || '')}">`;
    tb.querySelector('input').onchange = (ev) => { e.tbName = ev.target.value.trim(); renderPanel(); renderAssets(); };
    panelBody.append(nm, tb);
    panelBody.append(btn('Retirer de la bibliothèque', () => {
      if (!confirmBox(`Retirer « ${e.name} » et tous ses objets placés ?`)) return;
      pushUndo('o');
      objects.removeLibraryEntry(e.id);
      delete toolSettings.scatter.species[e.id];
      toolSettings.placeLib = objects.library[0]?.id;
      renderPanel(); renderAssets(); updateInfo();
    }, 'danger'));
  }
}

async function importSatImage() {
  const f = await pickFile('.png,.jpg,.jpeg,.webp');
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const side = Math.min(8192, Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = c.height = side;
    c.getContext('2d').drawImage(bmp, 0, 0, side, side);
    terrain.setSat(c);
    state.settings.satCredit = '';
    dirtyProject = true;
    renderPanel();
    toast('Image satellite appliquée');
  } catch (err) {
    alertDialog('Image illisible', esc(err.message || String(err)));
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
      id, name: values.name, tbName: values.tbName, color: '#c08040', cat: 'Mes modèles',
      modelData: dataUrl, modelFormat: ext === 'obj' ? 'obj' : 'gltf', modelScale: +values.scale || 1,
    });
    const s = entry.modelScale;
    if (s !== 1) for (const p of objects.groups.get(id).parts) p.matrix.premultiply(new THREE.Matrix4().makeScale(s, s, s));
    entry.height = (entry.height || 5) * s;
    toolSettings.placeLib = id;
    clearThumb(id);
    setTool('place');
    toast(`Modèle « ${values.name} » ajouté`);
  } catch (err) {
    console.error(err);
    alertDialog('Import impossible', `Le fichier n'a pas pu être lu : ${esc(err.message || err)}. Pour un GLTF, utilise plutôt un GLB (fichier unique avec textures intégrées).`);
  }
}

// ======================================================================
// Catalogue d'objets (bas de l'écran)
// ======================================================================
const assetsEl = document.getElementById('assets');
const assetUI = { filter: '', cat: '', size: 92, open: true, view: 'lib', group: '' };
assetsEl.innerHTML = `
  <div class="as-bar">
    <button class="small" data-a="toggle" title="Replier / déplier">▾</button>
    <b>📦 Objets</b>
    <select data-k="view" title="Ce qui est affiché dans le catalogue"></select>
    <input type="text" data-k="filter" placeholder="Filtrer (nom, modèle)…">
    <select data-k="cat"></select>
    <input type="range" data-k="size" min="64" max="150" value="92" title="Taille des vignettes">
    <label title="Rotation aléatoire à la pose"><input type="checkbox" data-k="rot" checked> Rot. aléatoire</label>
    <button class="small primary" data-a="a3" title="Indique où se trouvent tes modèles Arma 3 (.pbo ou dossier)">🎮 Modèles Arma 3</button>
    <button class="small" data-a="model" title="Importer un modèle GLB / GLTF / OBJ">+ GLB/OBJ</button>
    <button class="small" data-a="names">+ Par nom</button>
    <span class="count"></span>
    <span class="as-hint note" style="margin-left:auto;white-space:nowrap">Clique un objet, puis clique sur le terrain pour le poser.</span>
  </div>
  <div class="as-grid"></div>`;
const asGrid = assetsEl.querySelector('.as-grid');
assetsEl.querySelector('[data-k=filter]').oninput = (e) => { assetUI.filter = e.target.value.toLowerCase(); renderAssets(); };
assetsEl.querySelector('[data-k=cat]').onchange = (e) => { if (assetUI.view === 'a3') assetUI.group = e.target.value; else assetUI.cat = e.target.value; renderAssets(); };
assetsEl.querySelector('[data-k=view]').onchange = (e) => { assetUI.view = e.target.value; renderAssets(); };
assetsEl.querySelector('[data-k=size]').oninput = (e) => { asGrid.style.setProperty('--thumb', e.target.value + 'px'); };
assetsEl.querySelector('[data-k=rot]').onchange = (e) => { toolSettings.placeRandomRot = e.target.checked; if (state.tool === 'place') renderPanel(); };
assetsEl.querySelector('[data-a=toggle]').onclick = (e) => {
  assetUI.open = !assetUI.open;
  assetsEl.classList.toggle('closed', !assetUI.open);
  e.target.textContent = assetUI.open ? '▾' : '▴';
  resize();
};
assetsEl.querySelector('[data-a=model]').onclick = () => importModel();
assetsEl.querySelector('[data-a=names]').onclick = () => addByNames();
assetsEl.querySelector('[data-a=a3]').onclick = () => a3Dialog();

// ---------- Source des vrais modèles Arma 3 ----------
const a3 = new A3Source();
const a3Thumbs = new Map(); // key -> dataURL ('' = illisible)
const A3_MAX_CARDS = 400;
objects.p3dLoader = async (entry) => {
  if (!a3.count) return null;
  const key = (entry.p3d && a3.resolve(entry.p3d)) || a3.byName.get((entry.tbName || '').toLowerCase());
  if (!key) return null;
  const r = await loadP3DParts(a3, key);
  return { ...r, key };
};

function pickMany(dir) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    if (dir) inp.webkitdirectory = true; else inp.accept = '.pbo,.p3d,.paa';
    inp.onchange = () => resolve([...inp.files]);
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}

async function a3Dialog() {
  const choice = await new Promise((resolve) => {
    dlgForm.innerHTML = `<h2>Modèles Arma 3</h2>
      <div><p>Indique à TerraForge où se trouvent tes modèles : il lit directement les vrais fichiers <b>.p3d</b> et leurs textures, et les affiche dans le catalogue et sur la carte.</p>
      <p class="note">Tu peux choisir :<br>
      • des fichiers <b>.pbo</b> du jeu ou d'un mod (par ex. dans <code>…\\steamapps\\common\\Arma 3\\Addons</code> : structures_f*.pbo, plants_f.pbo, rocks_f.pbo…) ;<br>
      • un <b>dossier</b> entier : le dossier Addons, un dossier de mod, ou ton lecteur P: (par ex. <code>P:\\a3</code>).</p>
      <p class="note">Rien n'est envoyé sur Internet : les fichiers restent sur ton PC. Si le navigateur demande « Importer N fichiers ? », c'est normal, accepte. Chacun choisit son propre emplacement ; il faut le redonner à chaque ouverture de TerraForge.</p>
      ${a3.count ? `<p><b>${a3.count}</b> modèles déjà disponibles (${esc(a3.labels.slice(0, 6).join(', '))}${a3.labels.length > 6 ? '…' : ''}).</p>` : ''}</div>
      <menu><button value="cancel">Fermer</button><button value="files" class="primary">Choisir des fichiers .pbo…</button><button value="dir" class="primary">Choisir un dossier…</button></menu>`;
    dlg.onclose = () => resolve(dlg.returnValue);
    dlg.showModal();
  });
  if (choice !== 'files' && choice !== 'dir') return;
  const files = await pickMany(choice === 'dir');
  if (files.length) await connectA3(files);
}

// Ajoute des fichiers à la source, puis remplace les formes simplifiées par les vrais modèles.
async function connectA3(files) {
  let res = null, upgraded = 0;
  await busy('Lecture des fichiers Arma 3…', async () => {
    res = await a3.addFiles(files, async (m) => { setBusy(m); await tick(); });
    if (!res.models) return;
    let i = 0;
    for (const e of objects.library) {
      i++;
      if (e.modelData || (e.p3d && !e._missing)) continue;
      setBusy(`Chargement des vrais modèles (${i}/${objects.library.length})`);
      const r = await objects.p3dLoader(e).catch((err) => { console.warn(e.tbName, err); return null; });
      if (!r) continue;
      objects.replaceParts(e.id, r.parts);
      e.height = r.height; e.p3d = r.key; delete e._missing;
      clearThumb(e.id);
      upgraded++;
      await tick();
    }
  });
  if (!res || !res.models) {
    alertDialog('Aucun modèle trouvé', 'Aucun fichier .p3d n\'a été trouvé dans ce que tu as choisi. Choisis des fichiers .pbo du jeu (dossier Addons), un dossier de mod, ou un dossier contenant des .p3d. Les fichiers .ebo (contenu chiffré de certains DLC) ne peuvent pas être lus.');
    return;
  }
  assetUI.view = 'a3';
  renderAssets();
  toast(`${res.models} modèles Arma 3 trouvés${upgraded ? `, ${upgraded} objets du catalogue remplacés par le vrai modèle` : ''}`, 4000);
}

// File d'attente des vignettes des modèles Arma 3 (un modèle à la fois).
const a3Queue = [];
let a3Busy = false;
async function a3Pump() {
  if (a3Busy) return;
  a3Busy = true;
  while (a3Queue.length) {
    const { key, img } = a3Queue.shift();
    if (!img.isConnected) continue;
    if (!a3Thumbs.has(key)) {
      try {
        const r = await loadP3DParts(a3, key, { maxFaces: 6000, texSize: 128 });
        a3Thumbs.set(key, renderThumb(r.parts));
        disposeParts(r.parts);
      } catch (err) { console.warn('Modèle illisible :', key, err.message); a3Thumbs.set(key, ''); }
      await new Promise((r) => setTimeout(r, 0));
    }
    const url = a3Thumbs.get(key);
    if (url) img.src = url; else img.closest('.as-card')?.classList.add('bad');
  }
  a3Busy = false;
}
const a3Observer = new IntersectionObserver((ents) => {
  for (const en of ents) if (en.isIntersecting) {
    a3Observer.unobserve(en.target);
    a3Queue.push({ key: en.target.dataset.key, img: en.target });
  }
  a3Pump();
}, { root: asGrid, rootMargin: '150px' });

async function useA3Model(m) {
  let e = objects.library.find((x) => x.p3d === m.key) || objects.library.find((x) => !x.modelData && (x.tbName || '').toLowerCase() === m.name.toLowerCase());
  if (!e) {
    e = await objects.addLibraryEntry({ id: 'a3_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name: m.name, tbName: m.name, cat: guessCategory(m.key), p3d: m.key });
    if (e._missing) { toast('Ce modèle n\'a pas pu être lu'); }
  }
  toolSettings.placeLib = e.id;
  setTool('place');
}

const EMPTY_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
function renderAssets() {
  const viewSel = assetsEl.querySelector('[data-k=view]');
  if (!a3.count) assetUI.view = 'lib';
  viewSel.innerHTML = `<option value="lib">Ma bibliothèque (${objects.library.length})</option>` + (a3.count ? `<option value="a3">Arma 3 (${a3.count})</option>` : '');
  viewSel.value = assetUI.view;
  const sel = assetsEl.querySelector('[data-k=cat]');
  const keepScroll = asGrid.dataset.view === assetUI.view ? asGrid.scrollTop : 0;
  asGrid.dataset.view = assetUI.view;
  asGrid.innerHTML = '';
  a3Queue.length = 0;
  requestAnimationFrame(() => { asGrid.scrollTop = keepScroll; });
  if (assetUI.view === 'a3') {
    const groups = new Map();
    for (const m of a3.models) groups.set(m.group, (groups.get(m.group) || 0) + 1);
    const names = [...groups.keys()].sort();
    if (assetUI.group && !groups.has(assetUI.group)) assetUI.group = '';
    sel.innerHTML = `<option value="">Tous les dossiers</option>` + names.map((g) => `<option value="${esc(g)}" ${g === assetUI.group ? 'selected' : ''}>${esc(g)} (${groups.get(g)})</option>`).join('');
    const list = a3.models.filter((m) => (!assetUI.group || m.group === assetUI.group) && (!assetUI.filter || m.name.toLowerCase().includes(assetUI.filter) || m.key.includes(assetUI.filter)));
    assetsEl.querySelector('.count').textContent = list.length > A3_MAX_CARDS ? `${A3_MAX_CARDS} affichés sur ${list.length} (affine le filtre)` : `${list.length} modèles`;
    const active = state.tool === 'place' ? objects.entry(toolSettings.placeLib)?.p3d : null;
    for (const m of list.slice(0, A3_MAX_CARDS)) {
      const card = document.createElement('div');
      card.className = 'as-card' + (m.key === active ? ' active' : '');
      card.title = `${m.name}\n${m.key}`;
      card.innerHTML = `<img alt="" src="${a3Thumbs.get(m.key) || EMPTY_IMG}"><div class="nm">${esc(m.name)}</div><div class="tb">${esc(m.group)}</div>`;
      if (a3Thumbs.get(m.key) === '') card.classList.add('bad');
      const img = card.querySelector('img');
      if (!a3Thumbs.has(m.key)) { img.dataset.key = m.key; a3Observer.observe(img); }
      card.onclick = () => useA3Model(m);
      asGrid.append(card);
    }
    return;
  }
  const cats = CATEGORIES.filter((c) => objects.library.some((e) => (e.cat || 'Divers') === c));
  sel.innerHTML = `<option value="">Toutes les catégories</option>` + cats.map((c) => `<option ${c === assetUI.cat ? 'selected' : ''}>${c}</option>`).join('');
  const list = objects.library.filter((e) =>
    (!assetUI.cat || (e.cat || 'Divers') === assetUI.cat) &&
    (!assetUI.filter || `${e.name} ${e.tbName}`.toLowerCase().includes(assetUI.filter)));
  assetsEl.querySelector('.count').textContent = `${list.length} / ${objects.library.length} modèles`;
  for (const e of list) {
    const card = document.createElement('div');
    card.className = 'as-card' + (state.tool === 'place' && e.id === toolSettings.placeLib ? ' active' : '') + (e.p3d && !e._missing ? ' real' : '');
    card.title = `${e.name}\n${e.tbName || ''}` + (e.p3d && !e._missing ? '\nVrai modèle Arma 3' : e._missing ? '\nModèle Arma 3 non trouvé : redonne la source avec « Modèles Arma 3 »' : '\nForme simplifiée');
    card.innerHTML = `<img alt="" loading="lazy" src="${thumbnail(objects, e.id)}"><div class="nm">${esc(e.name)}</div><div class="tb">${esc(e.tbName || '')}</div>`;
    card.onclick = () => { toolSettings.placeLib = e.id; setTool('place'); };
    asGrid.append(card);
  }
}

// Ajoute des modèles à partir de leurs noms Terrain Builder (un par ligne).
async function addByNames() {
  const v = await formDialog('Ajouter des objets par nom', [
    { key: 'names', label: 'Noms Terrain Builder', type: 'textarea', value: '', placeholder: 'Un nom par ligne, par ex.\nLand_MaMaison_01\nmon_arbre_02' },
    { key: 'cat', label: 'Catégorie', type: 'select', value: 'Mes modèles', options: CATEGORIES.map((c) => [c, c]) },
    { key: 'shape', label: 'Forme d\'aperçu', type: 'select', value: 'box', options: [['box', 'Boîte'], ['house', 'Maison'], ['leafy', 'Arbre feuillu'], ['conifer', 'Conifère'], ['bush', 'Buisson'], ['rock', 'Rocher'], ['wall', 'Mur'], ['pole', 'Poteau']] },
    { key: 'height', label: 'Hauteur (m)', type: 'number', value: 5 },
  ], 'Colle ici les noms des modèles de ta bibliothèque Terrain Builder (objets de mods compris). Ils apparaîtront dans le catalogue avec une forme simplifiée, et seront exportés sous ce nom exact.');
  if (!v) return;
  const names = v.names.split(/\r?\n/).map((n) => n.trim().replace(/\.p3d$/i, '')).filter(Boolean);
  let n = 0;
  for (const name of names) {
    if (objects.library.some((e) => (e.tbName || '').toLowerCase() === name.toLowerCase())) continue;
    await objects.addLibraryEntry({
      id: 'n_' + Date.now().toString(36) + '_' + n++, name, tbName: name, cat: v.cat, shape: v.shape,
      color: ({ leafy: '#4b7a34', conifer: '#2f5a2a', bush: '#4e6b32', rock: '#85817a' })[v.shape] || '#b8a98c',
      height: Math.max(0.5, v.height || 5), w: 8, d: 6,
    });
  }
  renderAssets();
  toast(`${n} modèle(s) ajouté(s)`);
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
        if (f.type === 'textarea')
          return `<div class="row"><label>${f.label}</label><textarea name="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(String(f.value))}</textarea></div>`;
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
const busyEl = document.createElement('div');
busyEl.id = 'busy';
document.body.append(busyEl);
async function busy(msg, fn) {
  busyEl.innerHTML = `<div>${LOGO}<p></p></div>`;
  setBusy(msg);
  busyEl.classList.add('show');
  await new Promise((r) => setTimeout(r, 60));
  try { return await fn(); } finally { busyEl.classList.remove('show'); }
}

function setBusy(msg) { const p = busyEl.querySelector('p'); if (p) p.textContent = msg; }
const tick = () => new Promise((r) => setTimeout(r, 30));

// ---------- Import du monde réel ----------
async function doGeo() {
  const cfg = await openGeoDialog();
  if (!cfg) return;
  if (dirtyProject && !confirmBox('Les modifications non enregistrées seront perdues. Continuer ?')) return;
  let warning = '';
  try {
    await busy('Import du monde réel…', async () => {
      const heights = cfg.relief ? await fetchElevation(cfg, setBusy) : null;
      let osm = { roads: [], buildings: [], areas: [] };
      if (cfg.roads || cfg.paths || cfg.landuse || cfg.trees || cfg.buildings) {
        const raw = await fetchOSM(cfg, setBusy);
        osm = parseOSM(raw, cfg);
        if (raw.failed.length) warning += `Les serveurs OpenStreetMap étaient saturés pour : ${raw.failed.join(', ')}. Le reste a été importé. Relance « Monde réel » dans quelques minutes pour avoir tout.`;
      }
      let sat = null;
      if (cfg.satellite) {
        try { sat = await fetchSatellite(cfg, setBusy); }
        catch (err) { console.error(err); warning += ' L\'image satellite n\'a pas pu être téléchargée.'; }
      }
      setBusy('Construction de la carte…');
      await tick();
      buildGeoMap(cfg, heights, osm, sat);
    });
  } catch (err) {
    console.error(err);
    return alertDialog('Import impossible', esc(err.message || String(err)));
  }
  if (warning) alertDialog('Import partiel', esc(warning));
  else toast(`Carte créée : ${roads.roads.length} routes, ${objects.objects.length.toLocaleString('fr-FR')} objets`, 4000);
}

function buildGeoMap(cfg, heights, osm, sat = null) {
  terrain.surfaces = SURFACE_SETS.altis.surfaces.map((s) => ({ ...s }));
  terrain.init(cfg.grid, cfg.cell, cfg.maskRes);
  if (heights) terrain.heights.set(heights); else terrain.heights.fill(10);
  terrain.updateHeights(0, 0, terrain.N - 1, terrain.N - 1);
  autoPaint(1, false);

  // Occupation du sol (dans cet ordre : le dernier peint gagne).
  const R = terrain.maskRes;
  let forestMask = null;
  const roles = { grass: ['grass'], drygrass: ['drygrass', 'grass'], concrete: ['concrete', 'gravel'], rock: ['rock'], sand: ['sand'], forest: ['forest', 'grass'], water: ['seabed', 'gravel', 'sand'] };
  for (const cls of Object.keys(roles)) {
    const m = rasterizeAreas(osm.areas, cls, terrain);
    if (!m) continue;
    if (cls === 'forest') forestMask = m;
    if (!cfg.landuse) continue;
    const idx = surfaceByRole(...roles[cls]);
    if (idx < 0) continue;
    for (let k = 0; k < R * R; k++) if (m[k]) terrain.surf[k] = idx;
  }
  terrain.redrawSurface(0, 0, R - 1, R - 1);

  const list = [];
  // Bâtiments
  for (const b of osm.buildings.slice(0, 20000))
    list.push({ lib: 'house', x: b.x, z: b.z, rot: b.rot, scale: Math.min(2.5, Math.max(0.6, Math.sqrt(b.area) / 9)) });
  // Arbres dans les forêts
  if (cfg.trees && forestMask) {
    let cells = 0;
    for (let k = 0; k < R * R; k++) cells += forestMask[k];
    const px = terrain.size / R;
    const want = Math.min(60000, Math.round(((cells * px * px) / 10000) * cfg.treeDensity));
    const mix = [['pine', 3], ['beech', 2], ['oak', 1]].filter(([id]) => objects.entry(id));
    const rnd = mulberry32(12345);
    for (let n = 0, tries = want * 30; n < want && tries > 0 && mix.length; tries--) {
      const k = Math.floor(rnd() * R * R);
      if (!forestMask[k]) continue;
      const [wx, wz] = terrain.maskToWorld(k % R, Math.floor(k / R));
      const x = wx + (rnd() - 0.5) * px, z = wz + (rnd() - 0.5) * px;
      if (!terrain.inside(x, z) || terrain.heightAt(x, z) < 0.5 || terrain.slopeAt(x, z) > 42) continue;
      let v = rnd() * 6, id = mix[0][0];
      for (const [i, w] of mix) { v -= w; if (v <= 0) { id = i; break; } }
      list.push({ lib: id, x, z, rot: rnd() * Math.PI * 2, scale: 0.8 + rnd() * 0.5 });
      n++;
    }
  }
  terrain.setSat(sat ? sat.canvas : null);
  objects.setObjects(list);
  roads.roads = osm.roads;
  roads.rebuild();
  Object.assign(state.settings, { name: cfg.name, author: cfg.author, geo: { lat: cfg.lat, lon: cfg.lon }, satCredit: sat ? sat.credit : '' });
  toolSettings.surface = 0;
  undoStack.length = redoStack.length = 0;
  dirtyProject = true;
  resetView(); renderPanel(); updateInfo();
  document.title = `${cfg.name} · TerraForge`;
}

async function doNew(first = false) {
  const cfg = await openWizard();
  if (!cfg) return false;
  if (!first && dirtyProject && !confirmBox('Les modifications non enregistrées seront perdues. Continuer ?')) return false;
  await busy('Création de la carte…', () => createMap(cfg));
  return true;
}

function createMap(cfg) {
  terrain.surfaces = cfg.surfaces;
  terrain.init(cfg.grid, cfg.cell, cfg.maskRes);
  const { heights, rivers } = generate(cfg.params, cfg.grid, terrain.size);
  terrain.heights.set(heights);
  terrain.updateHeights(0, 0, terrain.N - 1, terrain.N - 1);
  if (cfg.params.paint) autoPaint(cfg.params.seed); else { terrain.surf.fill(0); terrain.redrawSurface(0, 0, terrain.maskRes - 1, terrain.maskRes - 1); }
  // Lit des rivières
  const bed = surfaceByRole('gravel', 'dirt');
  if (cfg.params.paint && bed >= 0)
    for (const riv of rivers) for (let k = 0; k < riv.length - 1; k++) {
      const [x0, z0] = riv[k], [x1, z1] = riv[k + 1];
      const px = terrain.size / terrain.maskRes;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / px));
      for (let q = 0; q < n; q++) {
        const x = x0 + ((x1 - x0) * q) / n, z = z0 + ((z1 - z0) * q) / n;
        if (terrain.heightAt(x, z) > 0.3) terrain.paintSurface(x, z, Math.max(cfg.params.rivers.width * 0.6, px * 1.2), bed, 1);
      }
    }
  state.settings.name = cfg.name;
  state.settings.author = cfg.author;
  delete state.settings.geo;
  delete state.settings.satCredit;
  toolSettings.surface = 0;
  objects.setObjects([]);
  roads.roads = []; roads.rebuild();
  undoStack.length = redoStack.length = 0;
  dirtyProject = false;
  resetView(); renderPanel(); updateInfo();
  document.title = `${cfg.name} · TerraForge`;
}

function surfaceByRole(...roles) {
  for (const r of roles) {
    const i = terrain.surfaces.findIndex((s) => s.role === r);
    if (i >= 0) return i;
  }
  return -1;
}

// Peinture automatique : plage près de l'eau, roche et terre sur les pentes,
// herbe ailleurs avec des plaques d'herbe sèche et de sous-bois.
function autoPaint(seed = 1, patches = true) {
  const R = terrain.maskRes;
  const or0 = (i) => (i < 0 ? 0 : i);
  const grass = or0(surfaceByRole('grass'));
  const sand = or0(surfaceByRole('sand', 'gravel'));
  const rock = or0(surfaceByRole('rock', 'gravel'));
  const dirt = or0(surfaceByRole('dirt', 'gravel'));
  const dry = or0(surfaceByRole('drygrass', 'grass'));
  const forest = or0(surfaceByRole('forest', 'grass'));
  const seabed = or0(surfaceByRole('seabed', 'sand'));
  const { fbm } = makeNoise(seed);
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const [wx, wz] = terrain.maskToWorld(x, y);
      const h = terrain.heightAt(wx, wz);
      const sl = terrain.slopeAt(wx, wz);
      let s = grass;
      if (h < -1.5) s = seabed;
      else if (h < 2.5) s = sand;
      else if (sl > 34) s = rock;
      else if (sl > 23) s = dirt;
      else {
        const n = fbm(wx / 420, wz / 420, 3);
        if (patches) { if (n > 0.28) s = dry; else if (n < -0.3) s = forest; }
      }
      terrain.surf[y * R + x] = s;
    }
  terrain.redrawSurface(0, 0, R - 1, R - 1);
}

async function doSave() {
  const bytes = saveProject(state, terrain.sat ? await canvasToJPEG(terrain.sat) : null);
  download(bytes, `${state.settings.name || 'terrain'}.tfa3`);
  dirtyProject = false;
  toast('Projet enregistré (fichier .tfa3)');
}

async function doOpen() {
  const f = await pickFile('.tfa3');
  if (!f) return;
  try {
    const { json, heights, surf, sat } = loadProject(new Uint8Array(await f.arrayBuffer()));
    terrain.surfaces = json.surfaces;
    terrain.init(json.gridSize, json.cellSize, json.maskRes);
    terrain.heights.set(heights);
    terrain.updateHeights(0, 0, terrain.N - 1, terrain.N - 1);
    terrain.surf.set(surf);
    terrain.redrawSurface(0, 0, terrain.maskRes - 1, terrain.maskRes - 1);
    if (sat) {
      const bmp = await createImageBitmap(new Blob([sat], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      terrain.setSat(c);
    }
    await objects.setLibrary(json.library);
    renderAssets();
    objects.setObjects(json.objects);
    roads.types = json.roadTypes || roads.types;
    roads.roads = json.roads || [];
    roads.rebuild();
    if (json.settings) Object.assign(state.settings, json.settings);
    document.title = `${state.settings.name} · TerraForge`;
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
    { key: 'tag', label: 'Nom de la carte / du mod', value: state.settings.name || 'MonTerrain' },
    { key: 'offsetEast', label: 'Easting (décalage X)', type: 'number', value: 200000 },
    { key: 'offsetNorth', label: 'Northing (décalage Y)', type: 'number', value: 0 },
    { key: 'imageScale', label: 'Agrandir sat/masque', type: 'select', value: 1, options: [[1, `×1 (${terrain.maskRes} px)`], [2, `×2 (${terrain.maskRes * 2} px)`], [4, `×4 (${terrain.maskRes * 4} px)`]] },
    { key: 'xyz', label: 'Ajouter aussi un fichier XYZ', type: 'checkbox', value: false },
  ], 'Crée un .zip contenant le dossier du mod à décompresser sur P: : config.cpp, relief (ASC), image satellite et masque (PNG), layers.cfg, liste des objets, routes et mode d\'emploi.', 'Exporter');
  if (!v) return;
  const name = (v.tag || 'MonTerrain').trim().replace(/[^A-Za-z0-9_]/g, '_');
  try {
    const zip = await busy('Export en cours…', () => buildExportZip(state, { ...v, tag: name, author: state.settings.author, geo: state.settings.geo, satCredit: state.settings.satCredit, imageScale: +v.imageScale }));
    download(zip, `${name}_terraforge.zip`, 'application/zip');
    toast('Export terminé');
  } catch (err) {
    console.error(err);
    alertDialog('Export impossible', esc(err.message || String(err)));
  }
}

function doHelp() {
  alertDialog('Aide TerraForge', `
  <ul>
    <li><b>Vue</b> : clic droit pour tourner, clic molette pour déplacer, molette pour zoomer.</li>
    <li><b>Touches 1 à 9, 0</b> : changer d'outil. <b>[ ]</b> : taille du pinceau. <b>Ctrl+Z / Ctrl+Y</b> : annuler / rétablir. <b>Ctrl+S</b> : enregistrer.</li>
    <li><b>Relief</b> : clic pour monter, Maj+clic pour descendre. <b>Aplanir</b> : Ctrl+clic pour prendre l'altitude.</li>
    <li><b>Forêt</b> : règle le mélange d'essences, la densité et l'échelle, puis peins. Maj pour gommer.</li>
    <li><b>Routes</b> : clic pour poser des points, double-clic pour terminer.</li>
    <li><b>Monde réel</b> crée la carte à partir d'un vrai lieu : relief, routes, forêts, eau et bâtiments.</li>
    <li><b>Nouveau terrain</b> ouvre l'assistant : taille, style de relief, mer, rivières, volcan, canyon, surfaces.</li>
    <li><b>Exporter</b> produit un .zip contenant le dossier du mod, à décompresser sur P: ; le fichier LISEZMOI.txt explique chaque étape.</li>
  </ul>
  <p class="note">La compilation finale du terrain (WRP + PBO) se fait toujours avec les outils Arma 3 (Terrain Builder, Addon Builder ou pboProject).</p>`);
}

document.getElementById('topbar').addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.action;
  ({ new: () => doNew(), geo: doGeo, open: doOpen, save: doSave, 'import-hm': doImportHeightmap, export: doExport, undo, redo, help: doHelp })[a]?.();
});
window.addEventListener('beforeunload', (e) => { if (dirtyProject) { e.preventDefault(); e.returnValue = ''; } });

// ======================================================================
// Barre d'état
// ======================================================================
const stPos = document.getElementById('st-pos');
const stInfo = document.getElementById('st-info');
function updateStatus() {
  if (!hover) { stPos.textContent = '—'; return; }
  stPos.textContent = `X ${hover.x.toFixed(0)}  Y ${terrain.north(hover.z).toFixed(0)}  Alt. ${hover.y.toFixed(1)} m  Pente ${terrain.slopeAt(hover.x, hover.z).toFixed(0)}°`;
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
  await objects.setLibrary(DEFAULT_LIBRARY.map((e) => ({ ...e })));
  resize();
  setTool('raise');
  renderAssets();
  createMap({ name: 'MonTerrain', author: '', grid: 512, cell: 8, maskRes: 1024, surfaces: terrain.surfaces, params: defaultParams() });
  loop();
  window.__tf = state; // pratique pour le débogage dans la console
  window.__tfCreate = createMap;
  window.__tfGeo = { buildGeoMap, fetchElevation, parseOSM };
  window.__tfDefaults = defaultParams;
  window.__tfA3 = { a3, connectA3, useA3Model, camera, controls };
  if (!new URLSearchParams(location.search).has('nowizard')) doNew(true);
})();

document.getElementById('brand').insertAdjacentHTML('afterbegin', LOGO);
