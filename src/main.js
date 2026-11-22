import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Terrain } from './terrain.js';
import { DEFAULT_SURFACES } from './surfaces.js';
import { ObjectManager, DEFAULT_LIBRARY, CATEGORIES, thumbnail, clearThumb, renderThumb } from './objects.js';
import { A3Source } from './a3source.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { icon } from './icons.js';
import { loadP3DParts, disposeParts, guessCategory, loadTexture } from './a3models.js';
import { RoadManager } from './roads.js';
import { buildExportZip, parseASC, canvasToJPEG } from './exporters.js';
import logoUrl from './logo.jpg?inline';
import { GAMES, gameById } from './games.js';
import { buildGameZip, HEIGHTMAP_SIZES, defaultHeightmapSize } from './gameexport.js';
import { readTv4p, parseLayersCfg, readASCFile, baseName } from './tv4p.js';
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
const SKY = new THREE.Color('#8ebbd4');
scene.background = makeSky();
scene.fog = new THREE.Fog(SKY, 3000, 14000);

// Ciel en dégradé (jour, un peu plus profond au zénith). Le brouillard reprend la couleur de l'horizon.
function makeSky() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#16324d');
  grd.addColorStop(0.38, '#3d7eaa');
  grd.addColorStop(0.55, '#8ebbd4');
  grd.addColorStop(1, '#c5dbe8');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

const camera = new THREE.PerspectiveCamera(55, 1, 1, 60000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minPolarAngle = 0.01;
controls.maxPolarAngle = Math.PI - 0.01; // caméra libre : on peut aussi regarder vers le haut
controls.enableRotate = false; // la rotation et la molette sont gérées par la caméra libre (plus bas)
controls.enableZoom = false;
controls.screenSpacePanning = false;

scene.add(new THREE.HemisphereLight('#d7eeff', '#3e5344', 1.25));
const sun = new THREE.DirectionalLight('#fff4e2', 2.15);
sun.position.set(-3000, 5000, -2000);
scene.add(sun);
const fill = new THREE.DirectionalLight('#9fd4ff', 0.35);
fill.position.set(4000, 1800, 2800);
scene.add(fill);

const state = {
  settings: { radius: 60, strength: 0.5, falloff: 0.6, name: 'MonTerrain', author: '', game: 'arma3' },
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

// Curseur du pinceau : anneau lumineux qui suit le relief.
function makeBrushRing(opacity) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(65 * 3), 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x3aa8b8, depthTest: false, transparent: true, opacity });
  const line = new THREE.LineLoop(geo, mat);
  line.renderOrder = 20;
  line.visible = false;
  return line;
}
const cursor = makeBrushRing(0.95);
const cursorGlow = makeBrushRing(0.32);
const cursorInner = makeBrushRing(0.5);
scene.add(cursor, cursorGlow, cursorInner);
const cursorDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.7, 10, 8),
  new THREE.MeshBasicMaterial({ color: 0x3aa8b8, depthTest: false, transparent: true, opacity: 0.95 }),
);
cursorDot.renderOrder = 21;
cursorDot.visible = false;
scene.add(cursorDot);
const BRUSH_RINGS = [
  { line: cursor, scale: 1 },
  { line: cursorGlow, scale: 1.045 },
  { line: cursorInner, scale: 0.94 },
];

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
  { id: 'nav', icon: 'nav', label: 'Vue' },
  { id: 'raise', icon: 'raise', label: 'Relief', undo: 'h' },
  { id: 'smooth', icon: 'smooth', label: 'Lisser', undo: 'h' },
  { id: 'flatten', icon: 'flatten', label: 'Aplanir', undo: 'h' },
  { id: 'water', icon: 'water', label: 'Eau', undo: 'h' },
  { id: 'paint', icon: 'paint', label: 'Peindre', undo: 's' },
  { id: 'scatter', icon: 'scatter', label: 'Forêt', undo: 'o' },
  { id: 'place', icon: 'place', label: 'Objet', undo: 'o' },
  { id: 'select', icon: 'select', label: 'Sélect.', undo: 'o' },
  { id: 'road', icon: 'road', label: 'Routes', undo: 'rh' },
];

const toolSettings = {
  flattenLevel: 20,
  waterDepth: 4,
  surface: 0,
  paintHardness: 0.8,
  placeLib: null,
  placeRandomRot: true,
  scatter: {
    density: 250,     // arbres / hectare
    spacing: 4,       // distance mini (m)
    scaleMin: 0.8, scaleMax: 1.25,
    maxSlope: 35,
    avoidWater: true,
    species: {},
  },
  roadType: 1,
  roadMode: 'draw', // 'draw' : tracer une nouvelle route, 'edit' : sélectionner et modifier
};

const toolsEl = document.getElementById('tools');
for (const t of TOOLS) {
  const b = document.createElement('button');
  b.dataset.tool = t.id;
  b.title = t.label;
  b.innerHTML = `${icon(t.icon, 22)}<small>${t.label}</small>`;
  b.onclick = () => setTool(t.id);
  toolsEl.appendChild(b);
}
try {
  if (localStorage.getItem('tf-tools-collapsed') === '1') document.body.classList.add('tools-collapsed');
  if (localStorage.getItem('tf-panel-collapsed') === '1') document.body.classList.add('panel-collapsed');
} catch { /* stockage indisponible */ }
function chromeToggle(side) {
  const collapsed = side === 'left' ? 'tools-collapsed' : 'panel-collapsed';
  const key = side === 'left' ? 'tf-tools-collapsed' : 'tf-panel-collapsed';
  document.body.classList.toggle(collapsed);
  const on = document.body.classList.contains(collapsed);
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* idem */ }
  const btn = side === 'left' ? toolsEl.querySelector('.chrome-collapse') : document.querySelector('#panel .chrome-collapse');
  if (btn) {
    btn.title = on ? (side === 'left' ? 'Déplier la barre d\'outils' : 'Déplier le panneau') : (side === 'left' ? 'Replier la barre d\'outils' : 'Replier le panneau');
    btn.innerHTML = icon(on ? (side === 'left' ? 'chevR' : 'chevL') : (side === 'left' ? 'chevL' : 'chevR'), 14);
  }
  syncChrome();
}
{
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chrome-collapse';
  const on = document.body.classList.contains('tools-collapsed');
  b.title = on ? 'Déplier la barre d\'outils' : 'Replier la barre d\'outils';
  b.innerHTML = icon(on ? 'chevR' : 'chevL', 14);
  b.onclick = () => chromeToggle('left');
  toolsEl.appendChild(b);
}
{
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chrome-collapse';
  const on = document.body.classList.contains('panel-collapsed');
  b.title = on ? 'Déplier le panneau' : 'Replier le panneau';
  b.innerHTML = icon(on ? 'chevL' : 'chevR', 14);
  b.onclick = () => chromeToggle('right');
  document.getElementById('panel').prepend(b);
}

function setTool(id) {
  if (state.tool === 'road' && id !== 'road') { roads.cancelDraft(); roads.select(null); }
  state.tool = id;
  for (const b of toolsEl.children) b.classList.toggle('active', b.dataset.tool === id);
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: null,
  };
  if (id !== 'select') objects.select(null);
  if (id === 'road') {
    // S'il y a déjà des routes, on arrive en mode « Modifier » (clic = sélection).
    toolSettings.roadMode = roads.roads.length ? 'edit' : 'draw';
    if (toolSettings.roadMode === 'draw') roads.startDraft(toolSettings.roadType);
  }
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
let dragRoadPt = false;    // un point de la route sélectionnée est en cours de déplacement
// Tolérance de clic sur une route ou un point : plus large quand la caméra est loin.
const roadReach = () => Math.max(2.5, hover ? camera.position.distanceTo(new THREE.Vector3(hover.x, hover.y, hover.z)) * 0.012 : 4);
let lastFrame = performance.now();
let lastObjRefresh = 0;
let dirtyProject = false;
let saveHandle = null; // fichier .tfa3 choisi au premier enregistrement

// ---------- Gizmo de transformation (déplacer / tourner / échelle) ----------
const gizmoProxy = new THREE.Object3D();
scene.add(gizmoProxy);
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.9);
scene.add(gizmo.getHelper());
let gizmoMode = 'translate';
function setGizmoMode(m) {
  gizmoMode = m;
  gizmo.setMode(m);
  gizmo.setSpace(m === 'translate' ? 'world' : 'local');
  if (state.tool === 'select') renderPanel();
}
function syncGizmo() {
  const o = state.tool === 'select' ? objects.selected : null;
  if (!o) { if (gizmo.object) gizmo.detach(); return; }
  if (gizmo.dragging) return;
  gizmoProxy.position.set(o.x, terrain.heightAt(o.x, o.z) + (o.dy || 0), o.z);
  gizmoProxy.rotation.set(o.rx || 0, o.rot, o.rz || 0, 'YXZ');
  gizmoProxy.scale.setScalar(o.scale);
  if (gizmo.object !== gizmoProxy) gizmo.attach(gizmoProxy);
}
let gizmoStartScale = 1;
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (e.value) { pushUndo('o'); gizmoStartScale = objects.selected?.scale || 1; }
  else { syncGizmo(); if (state.tool === 'select') renderPanel(); updateInfo(); }
});
gizmo.addEventListener('objectChange', () => {
  const o = objects.selected;
  if (!o) return;
  const p = gizmoProxy.position;
  if (gizmoMode === 'translate') {
    const lim = terrain.size;
    p.x = Math.min(lim, Math.max(0, p.x)); p.z = Math.min(lim, Math.max(0, p.z));
    if (gizmo.axis === 'Y') o.dy = Math.round((p.y - terrain.heightAt(o.x, o.z)) * 100) / 100;
    else { objects.move(o, p.x, p.z); p.y = terrain.heightAt(p.x, p.z) + (o.dy || 0); }
  } else if (gizmoMode === 'rotate') {
    // cap (Y), puis inclinaison avant/arrière (X) et sur le côté (Z)
    const e = new THREE.Euler().setFromQuaternion(gizmoProxy.quaternion, 'YXZ');
    const clean = (v) => (Math.abs(v) < 1e-4 ? 0 : v);
    o.rot = e.y; o.rx = clean(e.x); o.rz = clean(e.z);
    if (!o.rx && !o.rz) { delete o.rx; delete o.rz; }
  } else {
    const sc = gizmoProxy.scale, base = gizmoStartScale;
    let v = sc.x;
    for (const c of [sc.y, sc.z]) if (Math.abs(c - base) > Math.abs(v - base)) v = c;
    o.scale = Math.min(10, Math.max(0.1, Math.abs(v)));
  }
  objects.markDirty(o.lib);
});

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
  if (state.tool === 'road' && hover && toolSettings.roadMode === 'draw') roads.updateDraft(hover);
  if (dragRoadPt && hover && roads.selected) {
    const p = roads.selected.points[roads.activePoint];
    if (p) { p[0] = Math.round(hover.x * 100) / 100; p[1] = Math.round(hover.z * 100) / 100; roads.updateSelection(); }
  }
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
    if (toolSettings.roadMode === 'draw') { roads.addDraftPoint(hover.x, hover.z); return; }
    // Mode « Modifier » : d'abord une poignée de la route sélectionnée, sinon une route.
    const reach = roadReach();
    const sel = roads.selected;
    const k = sel ? roads.pickPoint(sel, hover.x, hover.z, reach) : -1;
    if (k >= 0) {
      pushUndo('r');
      roads.select(roads.selected, k); // pushUndo ne change pas les objets route en place
      dragRoadPt = true;
      renderer.domElement.setPointerCapture(e.pointerId);
    } else {
      const r = roads.pick(hover.x, hover.z, reach);
      roads.select(r);
      if (r) toolSettings.roadType = r.type;
    }
    renderPanel();
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
    if (gizmo.axis) return; // clic sur une poignée du gizmo
    const o = objects.pick(hover.x, hover.z, Math.max(6, state.settings.radius * 0.15));
    objects.select(o);
    renderPanel();
    syncGizmo();
    if (o && e.altKey) { pushUndo('o'); dragObj = o; } // Alt + glisser : déplacement libre sur le sol
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
  if (dragRoadPt) { dragRoadPt = false; roads.rebuild(); renderPanel(); }
});

renderer.domElement.addEventListener('dblclick', () => {
  if (state.tool !== 'road') return;
  if (toolSettings.roadMode === 'draw') return finishRoad();
  // Mode « Modifier » : double-clic sur la route sélectionnée = nouveau point à cet endroit.
  const sel = roads.selected;
  if (!sel || !hover) return;
  if (roads.pickPoint(sel, hover.x, hover.z, roadReach()) >= 0) return;
  if (roads.distanceTo(sel, hover.x, hover.z) > roads.type(sel.type).width / 2 + roadReach()) return;
  pushUndo('r');
  roads.select(sel, roads.insertPoint(sel, hover.x, hover.z));
  roads.rebuild();
  renderPanel();
});

function deleteRoadPoint() {
  const sel = roads.selected;
  if (!sel || !sel.points[roads.activePoint]) return;
  if (sel.points.length <= 2) return toast('Une route a besoin d\'au moins 2 points');
  pushUndo('r');
  sel.points.splice(roads.activePoint, 1);
  roads.select(sel);
  roads.rebuild();
  renderPanel();
}
function deleteRoad() {
  const sel = roads.selected;
  if (!sel) return;
  pushUndo('r');
  roads.roads.splice(roads.roads.indexOf(sel), 1);
  roads.select(null);
  roads.rebuild();
  renderPanel(); updateInfo();
}

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
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); doSave(e.shiftKey); return; }
  if (k === '[') { state.settings.radius = Math.max(2, Math.round(state.settings.radius / 1.15)); renderPanel(); }
  if (k === ']') { state.settings.radius = Math.min(2000, Math.round(state.settings.radius * 1.15 + 1)); renderPanel(); }
  if (state.tool === 'road' && toolSettings.roadMode === 'edit') {
    if (k === 'escape') { roads.select(null); renderPanel(); }
    if (k === 'delete' || k === 'backspace') { if (roads.activePoint >= 0) deleteRoadPoint(); else deleteRoad(); }
  } else if (state.tool === 'road') {
    if (k === 'enter') finishRoad();
    if (k === 'escape') { roads.cancelDraft(); roads.startDraft(toolSettings.roadType); }
    if (k === 'backspace') roads.undoDraftPoint();
  }
  const sel = objects.selected;
  if (state.tool === 'select' && sel) {
    if (k === 'delete' || k === 'backspace') { pushUndo('o'); objects.remove([sel]); renderPanel(); updateInfo(); }
    if (k === ' ') { e.preventDefault(); if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur(); setGizmoMode({ translate: 'rotate', rotate: 'scale', scale: 'translate' }[gizmoMode]); }
    if (k === 'g' || k === 't') setGizmoMode('translate');
    if (k === 'r') setGizmoMode('rotate');
    if (k === 'y') setGizmoMode('scale');
    if (k === 'x') { sel.rot += (e.shiftKey ? -1 : 1) * Math.PI / 12; objects.markDirty(sel.lib); }
    if (k === '+' || k === '=') { sel.scale = Math.min(5, sel.scale * 1.1); objects.markDirty(sel.lib); }
    if (k === '-') { sel.scale = Math.max(0.2, sel.scale / 1.1); objects.markDirty(sel.lib); }
  }
  const n = parseInt(e.key, 10);
  if (!e.ctrlKey && n >= 1 && n <= TOOLS.length && !e.altKey) setTool(TOOLS[n === 0 ? 9 : n - 1].id);
  if (e.key === '0') setTool(TOOLS[9].id);
});
window.addEventListener('keyup', (e) => { shiftDown = e.shiftKey; ctrlDown = e.ctrlKey || e.metaKey; moveKeys.delete(e.code); });
window.addEventListener('blur', () => moveKeys.clear());

// Déplacement de la vue au clavier : ZQSD (ou WASD sur un clavier QWERTY) et les flèches.
// On lit la position physique des touches (e.code), donc ça marche quel que soit le clavier.
const MOVE = { KeyE: [0, 0, 1], PageUp: [0, 0, 1], KeyQ: [0, 0, -1], PageDown: [0, 0, -1], KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
const moveKeys = new Set();
// Réglage de vitesse (barre du bas), mémorisé d'une session à l'autre.
let moveSpeed = 1, lookSpeed = 1;
{
  const el = document.querySelector('#st-speed input'), lab = document.querySelector('#st-speed b');
  const apply = (v) => { moveSpeed = 2 ** v; controls.panSpeed = moveSpeed; lookSpeed = 2 ** (v * 0.5); lab.textContent = '×' + (moveSpeed >= 1 ? +moveSpeed.toFixed(1) : +moveSpeed.toFixed(2)); };
  let saved = 0;
  try { saved = parseFloat(localStorage.getItem('tf-move-speed')) || 0; } catch { /* stockage indisponible */ }
  el.value = saved; apply(+el.value);
  el.oninput = () => { apply(+el.value); try { localStorage.setItem('tf-move-speed', el.value); } catch { /* idem */ } };
  el.onchange = () => el.blur();
}
window.addEventListener('keydown', (e) => {
  if (!(e.code in MOVE) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches('input, select, textarea') || dlg.open) return;
  if (e.code.startsWith('Arrow') || e.code.startsWith('Page')) e.preventDefault();
  moveKeys.add(e.code);
});
// ----------------------------------------------------------------------
// Caméra libre (comme dans un éditeur de jeu) :
//  - clic droit maintenu (ou clic gauche avec l'outil Vue) : regarder autour de soi ;
//  - ZQSD : avancer / reculer / gauche / droite dans la direction du regard ;
//  - A / E : descendre / monter ; molette : avancer / reculer ; Maj : plus vite.
// La caméra tourne sur elle-même au lieu de tourner autour d'un point du terrain.
// ----------------------------------------------------------------------
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3();
const _ray = new THREE.Ray();
function groundUnderCamera() {
  const p = camera.position;
  return terrain.inside(p.x, p.z) ? Math.max(0, terrain.heightAt(p.x, p.z)) : 0;
}
// Replace le point visé par OrbitControls devant la caméra (sur le sol si on le regarde).
function retarget() {
  camera.getWorldDirection(_fwd);
  _ray.origin.copy(camera.position); _ray.direction.copy(_fwd);
  const hit = terrain.raycast(_ray);
  let d = hit ? hit.distanceTo(camera.position) : Math.max(60, camera.position.y - groundUnderCamera());
  d = Math.min(Math.max(d, 10), terrain.size * 3);
  controls.target.copy(camera.position).addScaledVector(_fwd, d);
}
function freeMove(delta) {
  camera.position.add(delta);
  const floor = groundUnderCamera() + 1.6; // ne pas passer sous le sol
  if (camera.position.y < floor) camera.position.y = floor;
  retarget();
}
// Regarder autour de soi.
let look = null;
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!controls.enabled || look) return;
  if (!(e.button === 2 || (e.button === 0 && state.tool === 'nav'))) return;
  look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* sans capture */ }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!look || e.pointerId !== look.id) return;
  const dx = e.clientX - look.x, dy = e.clientY - look.y;
  look.x = e.clientX; look.y = e.clientY;
  _euler.setFromQuaternion(camera.quaternion, 'YXZ');
  const k = 0.0032 * lookSpeed;
  _euler.y -= dx * k;
  _euler.x = Math.max(-1.55, Math.min(1.55, _euler.x - dy * k));
  _euler.z = 0;
  camera.quaternion.setFromEuler(_euler);
  retarget();
});
const endLook = (e) => { if (look && e.pointerId === look.id) { look = null; try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* idem */ } } };
renderer.domElement.addEventListener('pointerup', endLook);
renderer.domElement.addEventListener('pointercancel', endLook);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// Molette : avancer / reculer dans la direction du regard.
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!controls.enabled) return;
  camera.getWorldDirection(_fwd);
  const alt = Math.max(6, camera.position.y - groundUnderCamera());
  const step = -Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100) * alt * 0.22 * (shiftDown ? 3 : 1) * Math.sqrt(moveSpeed);
  freeMove(_move.copy(_fwd).multiplyScalar(step));
}, { passive: false });

function keyboardMove(dt) {
  if (!moveKeys.size) return;
  let mx = 0, mz = 0, my = 0;
  for (const c of moveKeys) { mx += MOVE[c][0]; mz += MOVE[c][1]; my += MOVE[c][2] || 0; }
  if (!mx && !mz && !my) return;
  camera.getWorldDirection(_fwd);
  _right.set(-_fwd.z, 0, _fwd.x);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
  _right.normalize();
  // Plus on est haut, plus on va vite : précis au ras du sol, rapide en survol.
  const alt = Math.max(8, camera.position.y - groundUnderCamera());
  const speed = alt * (shiftDown ? 3.2 : 1.1) * moveSpeed * dt / Math.hypot(mx, mz, my);
  _move.copy(_fwd).multiplyScalar(mz * speed).addScaledVector(_right, mx * speed);
  _move.y += my * speed;
  freeMove(_move);
}

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
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // La vue est plein écran (les panneaux sont en verre par-dessus). On décale la
  // projection pour que la carte reste cadrée dans la zone libre, pas sous les panneaux.
  const cs = getComputedStyle(document.documentElement);
  const left = parseFloat(cs.getPropertyValue('--chrome-left'));
  const right = parseFloat(cs.getPropertyValue('--chrome-right'));
  const top = parseFloat(cs.getPropertyValue('--chrome-top'));
  const bottom = parseFloat(cs.getPropertyValue('--chrome-bottom'));
  if ([left, right, top, bottom].every(Number.isFinite) && left + right < w && top + bottom < h) {
    const clearCx = left + (w - left - right) / 2;
    const clearCy = top + (h - top - bottom) / 2;
    camera.setViewOffset(w, h, w / 2 - clearCx, h / 2 - clearCy, w, h);
  }
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function updateCursor() {
  const show = hover && !['nav', 'place', 'select', 'road'].includes(state.tool);
  for (const ring of BRUSH_RINGS) ring.line.visible = !!show;
  cursorDot.visible = !!show;
  if (!show) return;
  const r = state.settings.radius;
  const col = state.tool === 'scatter' && shiftDown ? 0xff5050 : state.tool === 'raise' && shiftDown ? 0x60b0ff : 0x3aa8b8;
  for (const ring of BRUSH_RINGS) {
    const P = ring.line.geometry.attributes.position;
    const rr = r * ring.scale;
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const x = hover.x + Math.cos(a) * rr, z = hover.z + Math.sin(a) * rr;
      P.setXYZ(k, x, terrain.heightAt(x, z) + 1.5, z);
    }
    P.needsUpdate = true;
    ring.line.geometry.computeBoundingSphere();
    ring.line.material.color.setHex(col);
  }
  cursorDot.position.set(hover.x, hover.y + 1.8, hover.z);
  cursorDot.material.color.setHex(col);
  const dist = camera.position.distanceTo(cursorDot.position);
  cursorDot.scale.setScalar(Math.max(0.8, dist * 0.0035));
}

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  keyboardMove(dt);
  applyTool(dt);
  syncGizmo();
  objects.flush();
  updateCursor();
  updateHud();
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
function btn(label, fn, cls = '') { const b = document.createElement('button'); b.innerHTML = label; b.onclick = fn; if (cls) b.className = cls; return b; }

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
  panelTitle.innerHTML = `${icon(t.icon, 18)} ${t.label}`;
  panelBody.innerHTML = '';
  switch (state.tool) {
    case 'nav':
      panelBody.append(note('<b>Caméra libre</b> : maintiens le clic droit (ou le clic gauche avec cet outil) pour regarder autour de toi, et déplace-toi avec <b>ZQSD</b>. <b>A</b> / <b>E</b> : descendre / monter. <b>Molette</b> : avancer / reculer. <b>Maj</b> : plus vite. Clic molette : glisser la vue.'));
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
      panelBody.append(h3('Mélange'), objects.library.length ? libraryList(null, null, true) : note('Bibliothèque vide : ajoute d\'abord des arbres depuis <b>Modèles Arma 3</b> (catalogue du bas), puis règle ici leur proportion.'));
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
      panelBody.append(note('Clique un objet pour le sélectionner, puis utilise les <b>poignées</b> affichées dessus.<br><b>Espace</b> : changer de mode (déplacer, tourner, échelle) · <b>T</b> / <b>R</b> / <b>Y</b> : mode direct · <b>X</b> : pivoter de 15° · <b>Suppr</b> supprimer · <b>Alt + glisser</b> : déplacement libre.'));
      const modes = document.createElement('div');
      modes.className = 'seg';
      for (const [m, label, ic] of [['translate', 'Déplacer', 'nav'], ['rotate', 'Tourner', 'rotate'], ['scale', 'Échelle', 'scale']]) {
        const b = btn(icon(ic, 14) + label, () => setGizmoMode(m), gizmoMode === m ? 'active' : '');
        modes.append(b);
      }
      panelBody.append(modes);
      const o = objects.selected;
      if (o) {
        const e = objects.entry(o.lib);
        panelBody.append(h3('Objet sélectionné'));
        panelBody.append(note(`${esc(e?.name || o.lib)} (${esc(e?.tbName || '')})`));
        panelBody.append(slider('Rotation (°)', () => Math.round(((-o.rot * 180) / Math.PI % 360 + 360) % 360), (v) => { o.rot = (-v * Math.PI) / 180; objects.markDirty(o.lib); }, 0, 359, 1));
        const degOf = (v) => Math.round(((v || 0) * 180) / Math.PI);
        const setTilt = (k, v) => { o[k] = (v * Math.PI) / 180; if (!o.rx && !o.rz) { delete o.rx; delete o.rz; } objects.markDirty(o.lib); };
        panelBody.append(slider('Inclinaison avant/arrière (°)', () => degOf(o.rx), (v) => setTilt('rx', v), -180, 180, 1));
        panelBody.append(slider('Inclinaison sur le côté (°)', () => degOf(o.rz), (v) => setTilt('rz', v), -180, 180, 1));
        if (o.rx || o.rz) panelBody.append(btn('Remettre droit', () => { pushUndo('o'); delete o.rx; delete o.rz; objects.markDirty(o.lib); renderPanel(); }, 'small'));
        panelBody.append(slider('Échelle', () => +o.scale.toFixed(2), (v) => { o.scale = v; objects.markDirty(o.lib); }, 0.2, 4, 0.05));
        panelBody.append(slider('Décalage vertical (m)', () => o.dy || 0, (v) => { o.dy = v; objects.markDirty(o.lib); }, -5, 5, 0.1));
        panelBody.append(btn('Supprimer', () => { pushUndo('o'); objects.remove([o]); renderPanel(); updateInfo(); }, 'danger'));
      }
      break;
    }
    case 'road': {
      const edit = toolSettings.roadMode === 'edit';
      const modes = document.createElement('div');
      modes.className = 'row';
      const setMode = (m) => {
        toolSettings.roadMode = m;
        if (m === 'draw') { roads.select(null); roads.startDraft(toolSettings.roadType); } else roads.cancelDraft();
        renderPanel();
      };
      modes.append(btn('Modifier une route', () => setMode('edit'), edit ? 'primary' : ''), btn('Tracer une route', () => setMode('draw'), edit ? '' : 'primary'));
      panelBody.append(modes);
      const typeSelect = (current, onChange) => {
        const sel = document.createElement('div');
        sel.className = 'row';
        sel.innerHTML = `<label>Type</label><select>${roads.types.map((t) => `<option value="${t.id}" ${t.id === current ? 'selected' : ''}>${esc(t.name)} (${t.width} m)</option>`).join('')}</select>`;
        sel.querySelector('select').onchange = (e) => onChange(+e.target.value);
        return sel;
      };
      if (edit) {
        const r = roads.selected;
        if (!r) {
          panelBody.append(note('<b>Clique sur une route</b> pour la sélectionner : elle passe en surbrillance et ses réglages s\'affichent ici.'));
        } else {
          const t = roads.type(r.type);
          panelBody.append(h3(`Route ${roads.roads.indexOf(r) + 1} sur ${roads.roads.length}`));
          panelBody.append(note(`${Math.round(roads.length(r)).toLocaleString('fr-FR')} m · ${r.points.length} points · largeur ${t.width} m<br>Texture appliquée : ${t.tex ? `<code>${esc(t.tex.split('\\').slice(-1)[0])}</code>` : 'couleur unie (aucune texture)'}`));
          panelBody.append(typeSelect(r.type, (id) => { pushUndo('r'); r.type = id; toolSettings.roadType = id; roads.rebuild(); renderPanel(); }));
          panelBody.append(note('<b>Glisse un point</b> pour déplacer le tracé. <b>Double-clic</b> sur la route : ajouter un point. <b>Suppr</b> : retirer le point rouge (ou la route si aucun point n\'est choisi). <b>Échap</b> : désélectionner.'));
          const acts = document.createElement('div');
          acts.className = 'row';
          acts.append(btn('Retirer le point', deleteRoadPoint, 'small'), btn('Supprimer la route', deleteRoad, 'small danger'));
          panelBody.append(acts);
          if (r.raw) panelBody.append(btn('Adoucir le tracé (courbes)', () => { pushUndo('r'); delete r.raw; roads.rebuild(); renderPanel(); }, 'small'));
          else panelBody.append(btn('Tracé en segments droits', () => { pushUndo('r'); r.raw = true; roads.rebuild(); renderPanel(); }, 'small'));
          roadTypeEditor(r);
        }
      } else {
        panelBody.append(note('Clique pour ajouter des points. <b>Double-clic</b> ou <b>Entrée</b> pour terminer la route. <b>Retour arrière</b> : retirer le dernier point. <b>Échap</b> : annuler.'));
        panelBody.append(typeSelect(toolSettings.roadType, (id) => {
          toolSettings.roadType = id;
          if (roads.draft) roads.draft.type = id;
          renderPanel();
        }));
        roadTypeEditor();
        panelBody.append(btn('Terminer la route', finishRoad));
      }
      panelBody.append(h3(`Routes (${roads.roads.length})`));
      const list = document.createElement('div');
      list.className = 'list';
      roads.roads.slice(0, 150).forEach((r, i) => {
        const t2 = roads.type(r.type);
        const it = document.createElement('div');
        it.className = 'item' + (r === roads.selected ? ' active' : '');
        it.innerHTML = `<span class="sw" style="background:${t2.color}"></span><div class="grow">Route ${i + 1}<div class="sub">${esc(t2.name)} · ${r.points.length} points</div></div>`;
        it.querySelector('.grow').onclick = () => {
          toolSettings.roadMode = 'edit'; roads.cancelDraft();
          roads.select(r); toolSettings.roadType = r.type;
          const [x, z] = r.points[Math.floor(r.points.length / 2)];
          mcpApi.camera({ x, z });
          renderPanel();
        };
        it.append(btn(icon('close', 12), () => { pushUndo('r'); roads.roads.splice(i, 1); roads.rebuild(); renderPanel(); updateInfo(); }, 'small danger'));
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
        toast('Terrain nivelé sous les routes, passages sous les ponts dégagés');
      }));
      break;
    }
  }
}

// Réglages du type de route choisi : nom, largeur, texture (du jeu ou d'un mod chargé).
const ROAD_TEX = /road|path|highway|runway|track|street|asphalt|asf|pavement|silnice|cesta/;
const ROAD_TEX_NOT = /_end_|decal|light|sign|\\ui\\|damage|wreck/;
function roadTypeEditor(road = null) {
  const t = roads.type(road ? road.type : toolSettings.roadType);
  if (!t) return;
  panelBody.append(h3('Type de route'));
  if (road) panelBody.append(note(`Ces réglages valent pour <b>toutes les routes de ce type</b> (${roads.roads.filter((r) => r.type === t.id).length}). Pour changer seulement cette route, crée un nouveau type ci-dessous.`));
  const nm = document.createElement('div'); nm.className = 'row';
  nm.innerHTML = `<label>Nom</label><input type="text" value="${esc(t.name)}">`;
  nm.querySelector('input').onchange = (e) => { t.name = e.target.value || t.name; dirtyProject = true; renderPanel(); };
  const wd = document.createElement('div'); wd.className = 'row';
  wd.innerHTML = `<label>Largeur (m)</label><input type="number" min="1" max="60" step="0.5" value="${t.width}">`;
  wd.querySelector('input').onchange = (e) => { t.width = Math.min(60, Math.max(1, +e.target.value || t.width)); dirtyProject = true; roads.rebuild(); renderPanel(); };
  panelBody.append(nm, wd);
  const list = a3.count ? a3.textures(ROAD_TEX, ROAD_TEX_NOT) : [];
  if (t.tex && !list.includes(t.tex)) list.unshift(t.tex);
  const tx = document.createElement('div'); tx.className = 'row';
  const short = (k) => k.split('\\').slice(-1)[0].replace(/_c[ao]\.paa$/, '') + '  (' + k.split('\\').slice(0, 2).join('\\') + ')';
  tx.innerHTML = `<label>Texture</label><select><option value="">Couleur unie</option>${list.map((k) => `<option value="${esc(k)}" ${k === t.tex ? 'selected' : ''}>${esc(short(k))}</option>`).join('')}</select>`;
  tx.querySelector('select').onchange = (e) => { t.tex = e.target.value || undefined; dirtyProject = true; roads.rebuild(); renderPanel(); };
  panelBody.append(tx);
  if (t.tex) panelBody.append(note(`<code>${esc(t.tex)}</code><br>Cette texture est écrite dans RoadsLib.cfg à l'export.`));
  else if (!a3.count) panelBody.append(note('Pour choisir une vraie texture de route, charge d\'abord tes fichiers avec <b>Modèles Arma 3</b> (par ex. <code>roads_f.pbo</code> ou les .pbo d\'un mod).'));
  else if (!list.length) panelBody.append(note('Aucune texture de route trouvée dans les fichiers chargés. Ajoute <code>roads_f.pbo</code> ou les .pbo de ton mod.'));
  panelBody.append(btn(road ? '+ Nouveau type pour cette route' : '+ Nouveau type de route', () => {
    const id = Math.max(0, ...roads.types.map((x) => x.id)) + 1;
    roads.types.push({ ...t, id, name: t.name + ' (copie)' });
    toolSettings.roadType = id;
    if (road) { pushUndo('r'); road.type = id; roads.rebuild(); }
    if (roads.draft) roads.draft.type = id;
    dirtyProject = true;
    renderPanel();
  }, 'small'));
}

// Textures de route : chargées à la demande, puis les routes sont redessinées.
const roadTex = new Map();
roads.texFor = (path) => {
  if (roadTex.has(path)) return roadTex.get(path);
  roadTex.set(path, null);
  if (a3.resolve(path)) loadTexture(a3, path, 1024).then((r) => {
    if (!r) return;
    r.tex.anisotropy = 8;
    roadTex.set(path, r.tex);
    roads.rebuild();
  });
  return null;
};
// Textures du jeu proposées par défaut pour les types de départ.
const ROAD_DEFAULT_TEX = {
  1: 'a3\\roads_f\\roads_ae\\data\\surf_roadtarmac_main_road_ca.paa',
  2: 'a3\\roads_f\\roads_new\\data\\road_ca.paa',
  3: 'a3\\roads_f\\roads_ae\\data\\surf_roaddirt_road_ca.paa',
  4: 'a3\\roads_f\\roads_ae\\data\\surf_roadconcrete_city_road_ca.paa',
  5: 'a3\\roads_f\\roads_ae\\data\\surf_roaddirt_path_ca.paa',
};
function refreshRoadTextures() {
  for (const t of roads.types) if (!t.tex && ROAD_DEFAULT_TEX[t.id] && a3.resolve(ROAD_DEFAULT_TEX[t.id])) t.tex = ROAD_DEFAULT_TEX[t.id];
  for (const [k, v] of roadTex) if (!v) roadTex.delete(k); // nouvelles sources : on retente
  roads.rebuild();
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
for (const [a, ic] of [['new', 'newmap'], ['geo', 'globe'], ['open', 'open'], ['save', 'save'], ['import-hm', 'importhm'], ['export', 'export'], ['undo', 'undo'], ['redo', 'redo'], ['help', 'help']]) {
  const b = document.querySelector(`#topbar [data-action="${a}"]`);
  if (b) b.innerHTML = icon(ic, 15) + `<span>${b.textContent.trim()}</span>`;
}
const assetsEl = document.getElementById('assets');
const assetUI = { filter: '', cat: '', size: 92, open: true, view: 'lib', group: '' };
assetsEl.innerHTML = `
  <div class="as-bar">
    <button class="small" data-a="toggle" title="Replier / déplier">${icon('down', 14)}</button>
    <b>${icon('place', 16)} Objets</b>
    <select data-k="view" title="Ce qui est affiché dans le catalogue"></select>
    <input type="text" data-k="filter" placeholder="Filtrer (nom, modèle)…">
    <select data-k="cat"></select>
    <input type="range" data-k="size" min="64" max="150" value="92" title="Taille des vignettes">
    <label title="Rotation aléatoire à la pose"><input type="checkbox" data-k="rot" checked> Rot. aléatoire</label>
    <button class="small primary" data-a="a3" title="Indique où se trouvent tes modèles Arma 3 (.pbo ou dossier)">${icon('models', 14)} Modèles Arma 3</button>
    <button class="small" data-a="model" title="Importer un modèle GLB / GLTF / OBJ">+ GLB/OBJ</button>
    <button class="small" data-a="names">+ Par nom</button>
    <button class="small" data-a="eden" title="Importer un mapping fait dans l'éditeur Eden d'Arma 3 (ou un fichier d'objets Terrain Builder)">${icon('importhm', 14)} Mapping Eden</button>
    <span class="count"></span>
    <span class="as-hint note" style="margin-left:auto;white-space:nowrap">Clique un objet, puis clique sur le terrain pour le poser.</span>
  </div>
  <div class="as-grid"></div>`;
const asGrid = assetsEl.querySelector('.as-grid');
// Poignée de redimensionnement : tirer le bord haut du catalogue (double-clic : taille par défaut).
{
  const grip = document.createElement('div');
  grip.className = 'as-grip';
  grip.title = 'Tirer pour agrandir ou réduire le catalogue (double-clic : taille par défaut)';
  assetsEl.prepend(grip);
  const apply = (h) => {
    const max = Math.max(160, window.innerHeight - 220);
    assetsEl.style.height = Math.round(Math.min(max, Math.max(120, h))) + 'px';
    syncChrome();
  };
  try { const saved = +localStorage.getItem('tf-assets-h'); if (saved) assetsEl.style.height = saved + 'px'; } catch (e) { /* stockage indisponible */ }
  grip.addEventListener('pointerdown', (e) => {
    if (!assetUI.open) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = assetsEl.getBoundingClientRect().height;
    const move = (ev) => apply(h0 + (y0 - ev.clientY));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try { localStorage.setItem('tf-assets-h', parseInt(assetsEl.style.height, 10)); } catch (e2) { /* ignoré */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { assetsEl.style.height = ''; try { localStorage.removeItem('tf-assets-h'); } catch (e) { /* ignoré */ } syncChrome(); });
}
assetsEl.querySelector('[data-k=filter]').oninput = (e) => { assetUI.filter = e.target.value.toLowerCase(); renderAssets(); };
assetsEl.querySelector('[data-k=cat]').onchange = (e) => { if (assetUI.view === 'a3') assetUI.group = e.target.value; else assetUI.cat = e.target.value; renderAssets(); };
assetsEl.querySelector('[data-k=view]').onchange = (e) => { assetUI.view = e.target.value; renderAssets(); };
assetsEl.querySelector('[data-k=size]').oninput = (e) => { asGrid.style.setProperty('--thumb', e.target.value + 'px'); };
assetsEl.querySelector('[data-k=rot]').onchange = (e) => { toolSettings.placeRandomRot = e.target.checked; if (state.tool === 'place') renderPanel(); };
assetsEl.querySelector('[data-a=toggle]').onclick = (e) => {
  assetUI.open = !assetUI.open;
  assetsEl.classList.toggle('closed', !assetUI.open);
  e.currentTarget.innerHTML = icon(assetUI.open ? 'down' : 'up', 14);
  syncChrome();
};
assetsEl.querySelector('[data-a=model]').onclick = () => importModel();
assetsEl.querySelector('[data-a=names]').onclick = () => addByNames();
assetsEl.querySelector('[data-a=eden]').onclick = () => importMapping();
assetsEl.querySelector('[data-a=a3]').onclick = () => a3Dialog();
queueMicrotask(() => applyGame());
syncChrome();

// ---------- Source des vrais modèles Arma 3 ----------
const a3 = new A3Source();
const a3Thumbs = new Map(); // key -> dataURL ('' = illisible)
const a3Errors = new Map(); // key -> raison de l'échec de lecture
const A3_MAX_CARDS = 400;
objects.p3dLoader = async (entry) => {
  if (!a3.count) return null;
  const key = (entry.p3d && a3.resolve(entry.p3d)) || a3.byName.get((entry.tbName || '').toLowerCase());
  if (!key) return null;
  try {
    const r = await loadP3DParts(a3, key);
    return { ...r, key };
  } catch (err) { a3Errors.set(key, err.message || String(err)); throw err; }
};

function pickMany(dir, accept = '.pbo,.p3d,.paa') {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    if (dir) inp.webkitdirectory = true; else inp.accept = accept;
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
  if (res) refreshRoadTextures();
  if (!res || !res.models) {
    alertDialog('Aucun modèle trouvé', 'Aucun fichier .p3d n\'a été trouvé dans ce que tu as choisi. Choisis des fichiers .pbo du jeu (dossier Addons), un dossier de mod, ou un dossier contenant des .p3d. Les fichiers .ebo (contenu chiffré de certains DLC) ne peuvent pas être lus.');
    return;
  }
  refreshRoadTextures();
  assetUI.view = 'a3';
  renderAssets();
  renderPanel();
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
      } catch (err) { console.warn('Modèle illisible :', key, err); a3Thumbs.set(key, ''); a3Errors.set(key, err.message || String(err)); }
      await new Promise((r) => setTimeout(r, 0));
    }
    const url = a3Thumbs.get(key);
    if (url) img.src = url; else { const c = img.closest('.as-card'); if (c) { c.classList.add('bad'); c.title += '\nLecture impossible : ' + (a3Errors.get(key) || 'erreur inconnue'); } }
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
    if (e._missing) alertDialog('Modèle illisible', `TerraForge n'a pas réussi à lire <b>${esc(m.name)}</b>, il est donc affiché sous forme de cube (il sera quand même exporté sous son nom).<br><br>Raison technique : <code>${esc(a3Errors.get(m.key) || 'inconnue')}</code><br><span class="note">Chemin : ${esc(m.key)}</span>`);
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
  const cubes = objects.library.filter((e) => !e.modelData && !e.shape && (!e.p3d || e._missing)).length;
  const countEl = assetsEl.querySelector('.count');
  countEl.textContent = `${list.length} / ${objects.library.length} modèles`;
  if (cubes) {
    const w = document.createElement('b');
    w.className = 'as-warn';
    w.textContent = a3.count
      ? ` · ${cubes} en cube : introuvables dans les fichiers Arma 3 donnés (ajoute le .pbo ou le mod qui les contient)`
      : ` · ${cubes} en cube : clique sur « Modèles Arma 3 » et choisis ton dossier Addons pour voir les vrais modèles`;
    countEl.append(w);
  }
  if (!objects.library.length) {
    asGrid.innerHTML = `<div class="as-empty">Ta bibliothèque est vide.<br>Clique sur <b>Modèles Arma 3</b> pour indiquer où sont tes modèles (.pbo ou dossier), puis clique sur ceux que tu veux utiliser : ils s'ajoutent ici.</div>`;
    return;
  }
  for (const e of list) {
    const card = document.createElement('div');
    card.className = 'as-card' + (state.tool === 'place' && e.id === toolSettings.placeLib ? ' active' : '') + (e.p3d && !e._missing ? ' real' : '');
    card.title = `${e.name}\n${e.tbName || ''}` + (e.p3d && !e._missing ? '\nVrai modèle Arma 3' : e._missing ? '\nModèle Arma 3 non trouvé : redonne la source avec « Modèles Arma 3 »' : '\nForme simplifiée');
    card.innerHTML = `<img alt="" loading="lazy" src="${thumbnail(objects, e.id)}"><div class="nm">${esc(e.name)}</div><div class="tb">${esc(e.tbName || '')}</div>`;
    card.onclick = () => { toolSettings.placeLib = e.id; setTool('place'); };
    asGrid.append(card);
  }
}

// ---------- Import d'un mapping (éditeur Eden d'Arma 3 ou fichier d'objets Terrain Builder) ----------
// Script à lancer dans la console de débogage d'Eden : il copie tous les objets posés dans le presse-papiers.
const EDEN_SCRIPT = `private _out = [];
{
  private _m = (getModelInfo _x) select 0;
  if (_m != "") then {
    private _p = getPosATL _x;
    _out pushBack format ['"%1";%2;%3;%4;0;0;%5;%6;',
      _m select [0, (count _m) - 4],
      (_p select 0) toFixed 3, (_p select 1) toFixed 3,
      (getDir _x) toFixed 2, (getObjectScale _x) toFixed 3, (_p select 2) toFixed 3];
  };
} forEach (all3DENEntities select 0);
copyToClipboard (_out joinString toString [13, 10]);
systemChat format ["TerraForge : %1 objets copiés", count _out];`;

// Lit les lignes "Modèle";X;Y;Cap;Tangage;Roulis;Échelle;Hauteur;
function parseObjectLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"([^"]+)"\s*;(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].split(';').map((x) => parseFloat(x));
    if (!isFinite(v[0]) || !isFinite(v[1])) continue;
    out.push({ name: m[1].trim().replace(/\.p3d$/i, '').split(/[\\/]/).pop(), X: v[0], Y: v[1], yaw: v[2] || 0, pitch: v[3] || 0, roll: v[4] || 0, scale: v[5] > 0 ? v[5] : 1, Z: v[6] || 0 });
  }
  return out;
}

async function importMapping() {
  const res = await new Promise((resolve) => {
    dlgForm.innerHTML = `<h2>Importer un mapping</h2>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:560px">
        <p class="note"><b>Le plus simple :</b> dans l'éditeur Eden, utilise <b>Exporter dans Terrain Builder</b>, clique <b>Copier</b>, puis colle ici dans la zone du bas (ou enregistre le texte dans un fichier .txt et ouvre-le).</p>
        <p class="note">Autre méthode, si tu n'as pas ce menu : colle ce script dans la console de débogage d'Eden, il copie tous les objets posés dans le presse-papiers.</p>
        <textarea readonly data-k="script" style="min-height:60px;flex:none">${esc(EDEN_SCRIPT)}</textarea>
        <div><button type="button" class="small" data-a="copy">Copier le script</button> <button type="button" class="small" data-a="file">Ouvrir un fichier .txt (format Terrain Builder)…</button></div>
        <textarea data-k="data" placeholder='Colle ici les objets (Ctrl+V), une ligne par objet :\n"Land_i_House_Big_01_V1_F";12345.6;6789.1;90;0;0;1;0;'></textarea>
        <div class="row"><label>Position</label><select data-k="mode">
          <option value="keep">Garder les coordonnées d'Arma (même carte ou même taille)</option>
          <option value="center">Centrer le mapping sur ma carte</option></select></div>
        <div class="row"><label>Hauteur</label><select data-k="zmode">
          <option value="ground">Poser les objets sur le sol (conseillé)</option>
          <option value="abs">La hauteur du fichier est une altitude (export Eden)</option>
          <option value="rel">La hauteur du fichier est un décalage au-dessus du sol</option></select></div>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="replace"> Remplacer les objets déjà posés</label>
      </div>
      <menu><button value="cancel">Annuler</button><button value="ok" class="primary">Importer</button></menu>`;
    const q = (k) => dlgForm.querySelector(k);
    q('[data-a=copy]').onclick = async (e) => { try { await navigator.clipboard.writeText(EDEN_SCRIPT); } catch (err) { q('[data-k=script]').select(); document.execCommand('copy'); } e.target.textContent = 'Script copié'; };
    q('[data-a=file]').onclick = async () => { const f = await pickFile('.txt'); if (f) q('[data-k=data]').value = await f.text(); };
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? { text: q('[data-k=data]').value, mode: q('[data-k=mode]').value, zmode: q('[data-k=zmode]').value, replace: q('[data-k=replace]').checked } : null);
    dlg.showModal();
  });
  if (!res) return;
  const rows = parseObjectLines(res.text);
  if (!rows.length) { alertDialog('Rien à importer', 'Aucune ligne d\'objet reconnue. Chaque ligne doit ressembler à <code>"NomDuModèle";X;Y;Cap;0;0;Échelle;Hauteur;</code>'); return; }
  // Les exports Terrain Builder ont un décalage est de 200000.
  const xs = rows.map((r) => r.X), ys = rows.map((r) => r.Y);
  let minX = Math.min(...xs.slice(0, 50000)), maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rows) { if (r.X < minX) minX = r.X; if (r.X > maxX) maxX = r.X; if (r.Y < minY) minY = r.Y; if (r.Y > maxY) maxY = r.Y; }
  const eastOff = minX >= 200000 ? 200000 : 0;
  const S = (terrain.N - 1) * terrain.cell;
  let dx = -eastOff, dy = 0;
  if (res.mode === 'center') { dx = S / 2 - (minX + maxX) / 2; dy = S / 2 - (minY + maxY) / 2; }
  let added = 0, outside = 0, real = 0, simple = 0;
  await busy('Import du mapping…', async () => {
    const byName = new Map();
    for (const e of objects.library) if (e.tbName) byName.set(e.tbName.toLowerCase(), e);
    const names = [...new Set(rows.map((r) => r.name.toLowerCase()))];
    let i = 0;
    for (const low of names) {
      i++;
      if (byName.has(low)) continue;
      const name = rows.find((r) => r.name.toLowerCase() === low).name;
      setBusy(`Chargement des modèles (${i}/${names.length})`);
      const key = a3.byName.get(low);
      const e = await objects.addLibraryEntry({ id: 'a3_' + Date.now().toString(36) + '_' + i, name, tbName: name, cat: key ? guessCategory(key) : 'Divers', ...(key ? { p3d: key } : { shape: 'box', w: 3, d: 3, height: 3, color: '#8d8f93' }) }, false);
      byName.set(low, e);
      if (i % 5 === 0) await tick();
    }
    for (const e of byName.values()) if (names.includes((e.tbName || '').toLowerCase())) { if (e.p3d && !e._missing) real++; else simple++; }
    pushUndo('o');
    const zOf = (r, x, z) => {
      const v = res.zmode === 'rel' ? r.Z : res.zmode === 'abs' ? r.Z - terrain.heightAt(x, z) : 0;
      return Math.abs(v) > 0.005 ? Math.round(v * 1000) / 1000 : 0;
    };
    const list = res.replace ? [] : objects.objects.slice();
    for (const r of rows) {
      const x = r.X + dx, z = S - (r.Y + dy);
      if (!terrain.inside(x, z)) { outside++; continue; }
      list.push({ lib: byName.get(r.name.toLowerCase()).id, x, z, rot: (-r.yaw * Math.PI) / 180, scale: r.scale, dy: zOf(r, x, z), ...(r.pitch || r.roll ? { rx: (-r.pitch * Math.PI) / 180, rz: (-r.roll * Math.PI) / 180 } : {}) });
      added++;
    }
    objects.setObjects(list);
  });
  renderAssets(); renderPanel(); updateInfo();
  let msg = `<b>${added}</b> objets importés, avec ${real + simple} modèles différents : ${real} affichés en vrai, ${simple} en forme simplifiée.`;
  if (simple && !a3.count) msg += '<br>Charge tes fichiers avec <b>Modèles Arma 3</b> pour voir les vrais modèles : ils remplaceront les boîtes grises.';
  else if (simple) msg += '<br>Les modèles en boîte grise n\'ont pas été trouvés dans les fichiers chargés (mod non chargé ?). Ils seront quand même exportés sous leur nom.';
  if (outside) msg += `<br><span class="warn">${outside} objets sont en dehors de ta carte et ont été ignorés.</span> Essaie « Centrer le mapping sur ma carte », ou crée une carte de la même taille que celle d'Arma.`;
  alertDialog('Mapping importé', msg);
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
  let res;
  try { res = await runGeo(cfg); }
  catch (err) {
    console.error(err);
    return alertDialog('Import impossible', esc(err.message || String(err)));
  }
  if (res.warning) alertDialog('Import partiel', esc(res.warning));
  else toast(`Carte créée : ${roads.roads.length} routes, ${objects.objects.length.toLocaleString('fr-FR')} objets`, 4000);
}

// Fait l'import complet pour une configuration donnée (sans fenêtre de dialogue).
async function runGeo(cfg) {
  let warning = '', failed = [], causes = [];
  await busy('Import du monde réel…', async () => {
    const heights = cfg.relief ? await fetchElevation(cfg, setBusy) : null;
    let osm = { roads: [], buildings: [], areas: [] };
    if (cfg.roads || cfg.paths || cfg.landuse || cfg.trees || cfg.buildings) {
      const raw = await fetchOSM(cfg, setBusy);
      osm = parseOSM(raw, cfg);
      failed = raw.failed; causes = raw.causes;
      if (raw.failed.length) warning += `Les serveurs OpenStreetMap étaient saturés pour : ${raw.failed.join(', ')}. Le reste a été importé. Relance « Monde réel » sur la même zone, sans fermer TerraForge : seules les parties manquantes seront redemandées.${raw.causes.length ? ` (Détail : ${raw.causes.join(' ; ')})` : ''}`;
    }
    let sat = null;
    if (cfg.satellite) {
      try { sat = await fetchSatellite(cfg, setBusy); }
      catch (err) { console.error(err); warning += ' L\'image satellite n\'a pas pu être téléchargée.'; }
    }
    setBusy('Construction de la carte…');
    await tick();
    await buildGeoMap(cfg, heights, osm, sat);
  });
  return { warning, failed, causes, relief: cfg.reliefSource || null };
}

// Demi-emprise au sol (x, z) d'un modèle de la bibliothèque.
function footprint(id) {
  const g = objects.groups.get(id);
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  if (g) for (const p of g.parts) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    box.union(tmp.copy(p.geometry.boundingBox).applyMatrix4(p.matrix));
  }
  if (box.isEmpty()) return { hx: 5, hz: 3.5, cx: 0, cz: 0 };
  return { hx: Math.max(0.5, (box.max.x - box.min.x) / 2), hz: Math.max(0.5, (box.max.z - box.min.z) / 2) };
}

// Modèles utilisés pour les bâtiments du monde réel. Ceux de GEO_EXTRA ne sont ajoutés
// que si le vrai modèle est trouvé dans la source Arma 3 connectée.
const GEO_BUILDINGS = ['house', 'house2', 'housebig', 'housebig2', 'stonehouse', 'stoneshed', 'shop', 'garage', 'slum', 'shedbig'];
const GEO_EXTRA = [
  ['geo_stonebig', 'Grande maison en pierre', 'i_Stone_HouseBig_V1_F'],
  ['geo_shop2', 'Boutique 2', 'i_Shop_02_V1_F'],
  ['geo_addon', 'Annexe', 'i_Addon_02_V1_F'],
  ['geo_housesmall3', 'Petite maison 3', 'i_House_Small_03_V1_F'],
  ['geo_unfinished1', 'Immeuble en chantier', 'Unfinished_Building_01_F'],
  ['geo_unfinished2', 'Grand immeuble en chantier', 'Unfinished_Building_02_F'],
  ['geo_offices', 'Bureaux', 'Offices_01_V1_F'],
  ['geo_shedind', 'Hangar industriel', 'i_Shed_Ind_F'],
  ['geo_shedsmall', 'Petit hangar', 'Shed_Small_F'],
  ['geo_metalshed', 'Abri en tôle', 'Metal_Shed_F'],
  ['geo_carservice', 'Garage automobile', 'CarService_F'],
  ['geo_factory', 'Usine', 'Factory_Main_F'],
];

// Modèles de pont Arma 3 : [id, nom, modèle]. Choisis selon la largeur de la route.
const GEO_BRIDGES = [
  ['geo_bridge_highway', 'Pont autoroutier', 'Bridge_HighWay_F'],
  ['geo_bridge_asphalt', 'Pont routier', 'Bridge_Asphalt_F'],
  ['geo_bridge_small', 'Petit pont', 'Bridge_01_F'],
];

// Mesure d'un modèle de pont : longueur (axe z), largeur, et hauteur de la chaussée
// (le niveau qui porte la plus grande surface horizontale tournée vers le haut).
function bridgeShape(id) {
  const g = objects.groups.get(id);
  if (!g) return null;
  const box = new THREE.Box3(), tmp = new THREE.Box3(), hist = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  for (const p of g.parts) {
    const geo = p.geometry, pos = geo.attributes.position, idx = geo.index;
    if (!geo.boundingBox) geo.computeBoundingBox();
    box.union(tmp.copy(geo.boundingBox).applyMatrix4(p.matrix));
    const cnt = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < cnt; t += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(p.matrix);
      b.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(p.matrix);
      c.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(p.matrix);
      n.subVectors(b, a).cross(e.subVectors(c, a));
      const area = n.length() / 2;
      if (area < 1e-6 || Math.abs(n.y) / (2 * area) < 0.95) continue;
      const y = Math.round(((a.y + b.y + c.y) / 3) * 5) / 5;
      hist.set(y, (hist.get(y) || 0) + area);
    }
  }
  if (box.isEmpty()) return null;
  // On retient le plus haut des niveaux bien fournis : le dessus du tablier, pas son dessous.
  let max = 0;
  for (const v of hist.values()) max = Math.max(max, v);
  let deck = 0, found = false;
  for (const [y, v] of hist) if (v >= max * 0.6 && (!found || y > deck)) { deck = y; found = true; }
  return { len: box.max.z - box.min.z, wid: box.max.x - box.min.x, deck };
}

// Pose un ou plusieurs modèles de pont le long de chaque pont d'OpenStreetMap, à la
// hauteur du tablier. Les routes ainsi équipées sont marquées `deck` (pas de route au sol).
function placeBridges(osm, models) {
  const list = [];
  if (!models.length) return list;
  for (const r of osm.roads) {
    if (!r.bridge || r.points.length < 2) continue;
    const dk = roads.deck(r);
    if (dk.L < 8) continue;
    // routes et rues : pont routier ; chemins et sentiers : petit pont (à défaut, ce qui existe)
    const pref = r.type === 3 || r.type === 5 ? ['geo_bridge_small', 'geo_bridge_asphalt', 'geo_bridge_highway'] : ['geo_bridge_asphalt', 'geo_bridge_highway', 'geo_bridge_small'];
    const fit = pref.map((id) => models.find((m) => m.id === id)).find(Boolean);
    const n = Math.max(1, Math.round(dk.L / fit.len));
    const pitch = Math.atan2(dk.h1 - dk.h0, dk.L);
    for (let k = 0; k < n; k++) {
      // point du tracé à la distance voulue
      let want = ((k + 0.5) * dk.L) / n, run = 0, x = r.points[0][0], z = r.points[0][1], dx = 1, dz = 0;
      for (let i = 1; i < r.points.length; i++) {
        const [ax, az] = r.points[i - 1], [bx, bz] = r.points[i], l = Math.hypot(bx - ax, bz - az);
        if (l <= 0) continue;
        dx = (bx - ax) / l; dz = (bz - az) / l;
        if (run + l >= want || i === r.points.length - 1) { const u = Math.min(l, want - run); x = ax + dx * u; z = az + dz * u; break; }
        run += l;
      }
      const dy = dk.h(want) - fit.deck - terrain.heightAt(x, z);
      list.push({ lib: fit.id, x, z, rot: Math.atan2(dx, dz), scale: 1, dy: Math.round(dy * 100) / 100, ...(Math.abs(pitch) > 0.005 ? { rx: -pitch } : {}) });
    }
    r.deck = true;
  }
  return list;
}

// Pose des bâtiments à la place de ceux d'OpenStreetMap, sans chevauchement entre eux
// ni avec les routes. Pour chaque emprise réelle, on choisit le modèle dont la taille
// et la forme s'en approchent le plus (avec un peu de hasard entre modèles équivalents),
// toujours à sa taille d'origine (échelle 1). Une emprise bien plus grande que le modèle (maisons mitoyennes,
// entrepôt) reçoit plusieurs bâtiments côte à côte.
function placeBuildings(osm, libIds) {
  const models = libIds.filter((id) => objects.entry(id)).map((id) => ({ id, ...footprint(id) }));
  const CELL = 24, GAP = 0.6;
  const grid = new Map();   // rectangles posés
  const rgrid = new Map();  // points de route { x, z, r }
  const key = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
  const put = (g, x, z, v) => { const k = key(x, z); let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(v); };
  const near = (g, x, z, r, out = []) => {
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++)
      for (let gz = Math.floor((z - r) / CELL); gz <= Math.floor((z + r) / CELL); gz++) { const a = g.get(gx + ',' + gz); if (a) for (const v of a) out.push(v); }
    return out;
  };
  for (const r of osm.roads) {
    const t = roads.types.find((x) => x.id === r.type);
    const hw = (t ? t.width : 5) / 2;
    for (const p of roads.sample(r, 3)) put(rgrid, p.x, p.z, { x: p.x, z: p.z, r: hw });
  }
  // rectangle orienté : centre, axes, demi-tailles (rot autour de Y comme dans la scène)
  const rect = (x, z, rot, hx, hz) => { const c = Math.cos(rot), sn = Math.sin(rot); return { x, z, ax: c, az: -sn, bx: sn, bz: c, hx, hz }; };
  const inRect = (R, x, z, m) => { const dx = x - R.x, dz = z - R.z; return Math.abs(dx * R.ax + dz * R.az) <= R.hx + m && Math.abs(dx * R.bx + dz * R.bz) <= R.hz + m; };
  const overlap = (A, B) => {
    const dx = B.x - A.x, dz = B.z - A.z;
    for (const [ux, uz] of [[A.ax, A.az], [A.bx, A.bz], [B.ax, B.az], [B.bx, B.bz]]) {
      const ra = A.hx * Math.abs(A.ax * ux + A.az * uz) + A.hz * Math.abs(A.bx * ux + A.bz * uz);
      const rb = B.hx * Math.abs(B.ax * ux + B.az * uz) + B.hz * Math.abs(B.bx * ux + B.bz * uz);
      if (Math.abs(dx * ux + dz * uz) > ra + rb + GAP) return false;
    }
    return true;
  };
  const free = (R) => {
    const rad = Math.hypot(R.hx, R.hz);
    for (const o of near(grid, R.x, R.z, rad + 60)) if (overlap(R, o)) return false;
    for (const p of near(rgrid, R.x, R.z, rad + 8)) if (inRect(R, p.x, p.z, p.r + 0.5)) return false;
    return true;
  };
  const list = [];
  let skipped = 0;
  const rnd = mulberry32(4242);
  const sorted = osm.buildings.slice(0, 20000).sort((a, b) => b.area - a.area);
  for (const b of sorted) {
    if (!models.length) break;
    const len = b.len || Math.sqrt(b.area) * 1.2, wid = b.wid || Math.sqrt(b.area) / 1.2;
    // Candidats : chaque modèle, dans le sens de l'emprise ou tourné d'un quart de tour.
    const cands = [];
    for (const m of models) for (const turn of [0, 1]) {
      const a = turn ? m.hz : m.hx, c = turn ? m.hx : m.hz; // demi-tailles le long / en travers de l'emprise
      const raw = Math.min(len / (2 * a), wid / (2 * c));
      // écart de taille (un modèle qui déborde de l'emprise est plus pénalisé) + écart de forme
      const score = Math.abs(Math.log(raw)) * (raw < 1 ? 2 : 1) + 0.35 * Math.abs(Math.log((a / c) / (len / wid))) + rnd() * 0.2;
      cands.push({ m, turn, a, c, score });
    }
    cands.sort((p, q) => p.score - q.score);
    const ca = Math.cos(-b.rot), sa = Math.sin(-b.rot);
    let done = false;
    for (const cd of cands.slice(0, 6)) {
      {
        const s = 1; // les modèles gardent toujours leur taille d'origine
        const L = 2 * cd.a, W = 2 * cd.c;
        const n = Math.max(1, Math.min(10, Math.floor(len / (L + GAP + 0.05))));
        const rows = Math.max(1, Math.min(3, Math.floor(wid / (W + GAP + 0.05))));
        const rot = b.rot + (cd.turn ? Math.PI / 2 : 0);
        let any = false;
        for (let i = 0; i < n; i++) for (let j = 0; j < rows; j++) {
          const u = (i - (n - 1) / 2) * (len / n), v = (j - (rows - 1) / 2) * (wid / rows);
          const x = b.x + u * ca - v * sa, z = b.z + u * sa + v * ca;
          const R = rect(x, z, rot, cd.m.hx * s, cd.m.hz * s);
          if (!free(R)) continue;
          put(grid, x, z, R);
          list.push({ lib: cd.m.id, x, z, rot, scale: 1 });
          any = true;
        }
        if (any) done = true;
      }
      if (done) break;
    }
    if (!done) skipped++;
  }
  const hits = (x, z, m) => { for (const o of near(grid, x, z, 60)) if (inRect(o, x, z, m)) return true; return false; };
  const onRoad = (x, z, m) => { for (const p of near(rgrid, x, z, m + 8)) if (Math.hypot(p.x - x, p.z - z) < p.r + m) return true; return false; };
  return { list, skipped, hits, onRoad };
}

async function buildGeoMap(cfg, heights, osm, sat = null) {
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
  // La bibliothèque démarre vide : on ajoute seulement les modèles dont l'import a besoin
  // (vrai modèle si la source Arma 3 est connectée, forme simplifiée sinon).
  const need = [];
  if (osm.buildings.length) need.push(...GEO_BUILDINGS);
  if (cfg.trees) need.push('pine', 'beech', 'oak', 'olive', 'bush', 'bush2');
  const geoIds = [...GEO_BUILDINGS];
  let nLoad = 0;
  const load = async (entry) => {
    setBusy(`Chargement des modèles (${++nLoad})…`);
    await objects.addLibraryEntry(entry, false);
    await tick();
  };
  for (const id of need) {
    if (objects.entry(id)) continue;
    const d = DEFAULT_LIBRARY.find((e) => e.id === id);
    if (d) await load({ ...d });
  }
  if (osm.buildings.length && a3.count) for (const [id, name, tbName] of GEO_EXTRA) {
    if (!a3.byName.get(tbName.toLowerCase())) continue;
    if (!objects.entry(id)) await load({ id, name, tbName, shape: 'box', color: '#b9b2a4', height: 6, w: 10, d: 8, cat: 'Bâtiments' });
    geoIds.push(id);
  }
  // Ponts : seulement avec les vrais modèles Arma 3 (sinon la route est simplement surélevée).
  const bridgeModels = [];
  if (a3.count && osm.roads.some((r) => r.bridge)) for (const [id, name, tbName] of GEO_BRIDGES) {
    if (!a3.byName.get(tbName.toLowerCase())) continue;
    if (!objects.entry(id)) await load({ id, name, tbName, shape: 'box', color: '#9a9a9a', height: 2, w: 12, d: 40, cat: 'Ponts' });
    const sh = objects.entry(id).p3d && !objects.entry(id)._missing ? bridgeShape(id) : null;
    if (sh) bridgeModels.push({ id, ...sh });
  }
  setBusy('Construction de la carte…');
  await tick();
  // Sol nivelé sous les routes (praticables en véhicule), avant de poser quoi que ce soit.
  if (heights && osm.roads.length) roads.flattenUnder(osm.roads);
  // Bâtiments
  const placed = placeBuildings(osm, geoIds);
  for (const p of placed.list) list.push(p);
  for (const p of placeBridges(osm, bridgeModels)) list.push(p);
  if (cfg.trees) {
    const px = terrain.size / R;
    const rnd = mulberry32(12345);
    const pick = (mix) => {
      let total = 0;
      for (const [, w] of mix) total += w;
      let v = rnd() * total;
      for (const [i, w] of mix) { v -= w; if (v <= 0) return i; }
      return mix[0][0];
    };
    // Arbres dans les forêts
    if (forestMask) {
      let cells = 0;
      for (let k = 0; k < R * R; k++) cells += forestMask[k];
      const want = Math.min(60000, Math.round(((cells * px * px) / 10000) * cfg.treeDensity));
      const mix = [['pine', 3], ['beech', 2], ['oak', 1]].filter(([id]) => objects.entry(id));
      for (let n = 0, tries = want * 30; n < want && tries > 0 && mix.length; tries--) {
        const k = Math.floor(rnd() * R * R);
        if (!forestMask[k]) continue;
        const [wx, wz] = terrain.maskToWorld(k % R, Math.floor(k / R));
        const x = wx + (rnd() - 0.5) * px, z = wz + (rnd() - 0.5) * px;
        if (!terrain.inside(x, z) || terrain.heightAt(x, z) < 0.5 || terrain.slopeAt(x, z) > 42) continue;
        if (placed.hits(x, z, 2.5) || placed.onRoad(x, z, 2)) continue; // pas d'arbre dans une maison ni sur une route
        list.push({ lib: pick(mix), x, z, rot: rnd() * Math.PI * 2, scale: 0.8 + rnd() * 0.5 });
        n++;
      }
    }
    // Végétation éparse hors forêt : arbres isolés et buissons, jamais sur l'eau,
    // les zones bâties en dur, les champs cultivés, les routes ou les maisons.
    const bare = new Uint8Array(R * R);
    for (const cls of ['water', 'concrete', 'sand', 'rock']) {
      const m = rasterizeAreas(osm.areas, cls, terrain);
      if (m) for (let k = 0; k < R * R; k++) if (m[k]) bare[k] = 1;
    }
    const farm = rasterizeAreas(osm.areas.filter((a) => a.farm), 'drygrass', terrain);
    if (farm) for (let k = 0; k < R * R; k++) if (farm[k]) bare[k] = 1;
    const mix = [['oak', 2], ['beech', 2], ['olive', 2], ['pine', 1], ['bush', 4], ['bush2', 3]].filter(([id]) => objects.entry(id));
    const perHa = Math.max(1, Math.min(8, cfg.treeDensity * 0.04));
    const want = Math.min(25000, Math.round((terrain.size * terrain.size / 10000) * perHa));
    for (let n = 0, tries = want * 6; n < want && tries > 0 && mix.length; tries--) {
      const x = rnd() * terrain.size, z = rnd() * terrain.size;
      const [mx, my] = terrain.worldToMask(x, z);
      const k = Math.min(R - 1, Math.max(0, Math.floor(my))) * R + Math.min(R - 1, Math.max(0, Math.floor(mx)));
      if (bare[k] || (forestMask && forestMask[k])) continue;
      if (!terrain.inside(x, z) || terrain.heightAt(x, z) < 0.5 || terrain.slopeAt(x, z) > 38) continue;
      if (placed.hits(x, z, 3) || placed.onRoad(x, z, 3)) continue;
      list.push({ lib: pick(mix), x, z, rot: rnd() * Math.PI * 2, scale: 0.8 + rnd() * 0.5 });
      n++;
    }
  }
  terrain.setSat(sat ? sat.canvas : null);
  objects.setObjects(list);
  roads.roads = osm.roads;
  roads.rebuild();
  Object.assign(state.settings, { name: cfg.name, author: cfg.author, geo: { lat: cfg.lat, lon: cfg.lon }, satCredit: sat ? sat.credit : '' });
  toolSettings.surface = 0;
  undoStack.length = redoStack.length = 0; saveHandle = null;
  dirtyProject = true;
  resetView(); renderPanel(); updateInfo();
  document.title = `${cfg.name} · TerraForge`;
}

async function doNew(first = false) {
  const cfg = await openWizard(currentGame().surfaceSet, currentGame().name);
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
  undoStack.length = redoStack.length = 0; saveHandle = null;
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

// Fichier choisi lors du premier enregistrement : les suivants l'écrasent directement
// (navigateurs Chrome / Edge). Sinon, repli sur un téléchargement classique.
async function doSave(saveAs = false) {
  const name = `${state.settings.name || 'terrain'}.tfa3`;
  let handle = saveAs ? null : saveHandle;
  if (!handle && window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Projet TerraForge', accept: { 'application/octet-stream': ['.tfa3'] } }] });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // annulé par l'utilisateur
      handle = null; // sélecteur indisponible : téléchargement
    }
  }
  try {
    await busy('Enregistrement du projet…', async () => {
      const bytes = saveProject(state, terrain.sat ? await canvasToJPEG(terrain.sat) : null);
      if (handle) {
        const w = await handle.createWritable();
        await w.write(bytes);
        await w.close();
        saveHandle = handle;
      } else download(bytes, name);
      dirtyProject = false;
      toast(handle ? `Projet enregistré dans ${handle.name} (${(bytes.length / 1048576).toFixed(1)} Mo)` : `Projet enregistré : ${name} est dans tes Téléchargements (${(bytes.length / 1048576).toFixed(1)} Mo)`, 4000);
    });
  } catch (err) {
    console.error(err);
    alertDialog('Enregistrement impossible', `Le projet n'a pas pu être enregistré.<br><br>Raison technique : <code>${esc(err.message || String(err))}</code>`);
  }
}

async function doOpen() {
  const f = await pickFile('.tfa3,.tv4p');
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.tv4p')) return openTv4p(f);
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
    if (json.settings) Object.assign(state.settings, { game: 'arma3' }, json.settings);
    applyGame();
    document.title = `${state.settings.name} · TerraForge`;
    undoStack.length = redoStack.length = 0; saveHandle = null;
    dirtyProject = false;
    resetView(); renderPanel(); updateInfo();
    toast('Projet chargé');
  } catch (err) {
    console.error(err);
    alertDialog('Ouverture impossible', esc(err.message || String(err)));
  }
}

// ======================================================================
// Ouverture d'un projet Terrain Builder (.tv4p)
// ======================================================================
const TV_PARTS = [['relief', 'Relief'], ['sat', 'Image satellite'], ['mask', 'Masque des surfaces'], ['layers', 'Surfaces (layers.cfg)']];
const SURF_HINTS = [
  [/dry|sec|thorn|maquis/, 'drygrass', [150, 140, 85]], [/forest|foret|pine|pin/, 'forest', [62, 74, 40]],
  [/grass|herbe|green|wild/, 'grass', [92, 118, 58]], [/beach|sand|plage|sable/, 'sand', [196, 180, 140]],
  [/seabed|sea|mer/, 'seabed', [120, 130, 110]], [/rock|roche|cliff|falaise/, 'rock', [120, 116, 110]],
  [/stony|gravel|gravier|stone|pierre/, 'gravel', [150, 146, 136]], [/concrete|beton|asphalt|road|route|city|ville/, 'concrete', [140, 140, 140]],
  [/dirt|terre|soil|mud|boue/, 'dirt', [118, 96, 70]],
];

async function openTv4p(file) {
  let proj;
  try { proj = readTv4p(new Uint8Array(await file.arrayBuffer())); }
  catch (err) { return alertDialog('Projet illisible', `TerraForge n'a pas réussi à lire <b>${esc(file.name)}</b>.<br><br>Raison technique : <code>${esc(err.message || String(err))}</code>`); }
  const fr = proj.frame;
  if (!fr || !fr.grid || !fr.cell) return alertDialog('Projet incomplet', 'Ce projet ne contient pas de zone de carte (« mapframe ») avec une taille de terrain.');
  if (dirtyProject && !confirmBox('Les modifications non enregistrées seront perdues. Continuer ?')) return;

  // Fichiers attendus (les derniers importés dans Terrain Builder gagnent).
  const want = {};
  for (const c of [...proj.contents].sort((a, b) => a.order - b.order)) if (c.kind in { relief: 1, sat: 1, mask: 1 }) want[c.kind] = c.path;
  if (fr.layersCfg) want.layers = fr.layersCfg;
  const got = {};
  const offer = (files) => {
    for (const [k] of TV_PARTS) {
      if (!want[k]) continue;
      const segs = want[k].toLowerCase().split(/[\\/]/);
      let best = null, bestScore = 0;
      for (const f of files) {
        const fs = (f.webkitRelativePath || f.name).toLowerCase().split('/');
        let n = 0;
        while (n < fs.length && n < segs.length && fs[fs.length - 1 - n] === segs[segs.length - 1 - n]) n++;
        if (n > bestScore) { best = f; bestScore = n; }
      }
      if (best) got[k] = best;
    }
  };
  const grids = [fr.grid, fr.grid / 2, fr.grid / 4].filter((g) => g >= 256 && Number.isInteger(g));
  const opts = await new Promise((resolve) => {
    const draw = () => {
      dlgForm.innerHTML = `<h2>Projet Terrain Builder : ${esc(proj.name)}</h2>
        <div><p>Carte de <b>${(fr.width / 1000).toLocaleString('fr-FR')} km</b>, relief ${fr.grid} × ${fr.grid} (cellule ${+fr.cell.toFixed(3)} m).</p>
        <p class="note">Le fichier .tv4p ne contient que des réglages et des chemins. Pour retrouver ta carte, donne à TerraForge les fichiers ci-dessous : choisis le dossier qui les contient (par ex. <code>P:\\${esc(proj.name)}\\source</code>) ou les fichiers un par un. Rien n'est envoyé sur Internet.</p>
        <table class="tv-files">${TV_PARTS.filter(([k]) => want[k]).map(([k, label]) => `<tr><td>${label}</td><td><code>${esc(want[k])}</code></td><td class="${got[k] ? 'ok' : 'miss'}">${got[k] ? 'trouvé' : 'à fournir'}</td></tr>`).join('')}</table>
        <p><button type="button" data-p="dir">Choisir un dossier…</button> <button type="button" data-p="files">Choisir des fichiers…</button></p>
        <div class="row"><label>Précision du relief</label><select name="grid">${grids.map((g) => `<option value="${g}" ${g === Math.min(fr.grid, 2048) ? 'selected' : ''}>${g} × ${g}, cellule ${+(fr.width / g).toFixed(3)} m${g === fr.grid ? ' (comme le projet)' : ''}${g > 2048 ? ', très lourd' : ''}</option>`).join('')}</select></div>
        <div class="row"><label>Sat / masque dans l'éditeur</label><select name="res">${[1024, 2048, 4096].map((v) => `<option value="${v}" ${v === 2048 ? 'selected' : ''}>${v} px (${(fr.width / v).toFixed(1)} m/px)</option>`).join('')}</select></div>
        ${proj.objectCount ? `<p class="note">Ce projet déclare ${proj.objectCount.toLocaleString('fr-FR')} objets. Ils sont rangés dans les fichiers de calques (.tv4l), que TerraForge ne sait pas encore lire : la carte s'ouvrira sans eux.</p>` : ''}</div>
        <menu><button value="cancel" formnovalidate>Annuler</button><button value="ok" class="primary">Ouvrir la carte</button></menu>`;
      for (const b of dlgForm.querySelectorAll('[data-p]')) b.onclick = async () => {
        const keep = { grid: dlgForm.elements.grid.value, res: dlgForm.elements.res.value };
        offer(await pickMany(b.dataset.p === 'dir', '.asc,.png,.jpg,.jpeg,.bmp,.cfg'));
        draw();
        dlgForm.elements.grid.value = keep.grid; dlgForm.elements.res.value = keep.res;
      };
    };
    draw();
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? { grid: +dlgForm.elements.grid.value, res: +dlgForm.elements.res.value } : null);
    dlg.returnValue = '';
    dlg.showModal();
  });
  if (!opts) return;
  try {
    const report = await busy('Ouverture du projet…', () => loadTv4p(proj, got, opts));
    const missing = TV_PARTS.filter(([k]) => want[k] && !got[k]).map(([, l]) => l.toLowerCase());
    alertDialog('Projet ouvert', `<p>${report.map(esc).join('<br>')}</p>${missing.length ? `<p class="note">Non fourni : ${missing.join(', ')}.</p>` : ''}<p class="note">Pense à « Enregistrer projet » : TerraForge garde sa propre copie (.tfa3) et ne modifie jamais ton projet Terrain Builder.</p>`);
  } catch (err) {
    console.error(err);
    alertDialog('Ouverture impossible', esc(err.message || String(err)));
  }
}

async function imagePixels(file, side, pixelated) {
  const bmp = await createImageBitmap(file, { resizeWidth: side, resizeHeight: side, resizeQuality: pixelated ? 'pixelated' : 'medium' });
  const c = document.createElement('canvas');
  c.width = c.height = side;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = !pixelated;
  ctx.drawImage(bmp, 0, 0, side, side);
  bmp.close?.();
  return { canvas: c, ctx };
}

async function loadTv4p(proj, files, opts) {
  const fr = proj.frame, report = [];
  const N = opts.grid, R = opts.res, cell = fr.width / N;

  // Relief
  let relief = null;
  if (files.relief) {
    if (!/\.asc$/i.test(files.relief.name)) throw new Error(`Relief : seul le format .asc est lu pour l'instant (${files.relief.name}).`);
    setBusy('Lecture du relief…');
    relief = await readASCFile(files.relief, (f) => setBusy(`Lecture du relief… ${Math.round(f * 100)} %`));
  }
  // Surfaces et masque
  let surfaces = null, surf = null, layers = null;
  if (files.layers) layers = parseLayersCfg(await files.layers.text());
  let maskPx = null;
  if (files.mask) {
    setBusy('Lecture du masque…'); await tick();
    maskPx = (await imagePixels(files.mask, R, true)).ctx.getImageData(0, 0, R, R).data;
    if (!layers || !layers.length) {
      // Pas de layers.cfg : une surface par couleur présente dans le masque.
      const count = new Map();
      for (let i = 0; i < maskPx.length; i += 4) { const k = (maskPx[i] << 16) | (maskPx[i + 1] << 8) | maskPx[i + 2]; count.set(k, (count.get(k) || 0) + 1); }
      layers = [...count.entries()].sort((a, b) => b[1] - a[1]).filter(([, n], i) => i < 40 && n > R * R * 0.0005)
        .map(([k], i) => ({ id: `surface_${i + 1}`, rvmat: '', colors: [[k >> 16, (k >> 8) & 255, k & 255]] }));
    }
  }
  if (layers && layers.length) {
    surfaces = layers.slice(0, 255).map((l) => {
      const hint = SURF_HINTS.find(([re]) => re.test(l.id.toLowerCase()));
      const m = l.colors[0];
      return { id: l.id, name: l.id.replace(/^gdt_/i, '').replace(/_/g, ' '), role: hint ? hint[1] : '', mask: m, sat: hint ? hint[2] : m.map((v) => Math.round(v * 0.45 + 60)), rvmat: l.rvmat, _colors: l.colors };
    });
    // Un seul rôle par surface (le premier trouvé le garde).
    const seen = new Set();
    for (const s of surfaces) { if (seen.has(s.role)) s.role = ''; else seen.add(s.role); }
  }
  if (maskPx && surfaces) {
    setBusy('Lecture du masque…'); await tick();
    surf = new Uint8Array(R * R);
    const pal = [];
    surfaces.forEach((s, i) => { for (const c of s._colors) pal.push([c[0], c[1], c[2], i]); });
    const cache = new Map();
    let lastK = -1, lastI = 0;
    for (let i = 0, q = 0; i < surf.length; i++, q += 4) {
      const r = maskPx[q], g = maskPx[q + 1], b = maskPx[q + 2], k = (r << 16) | (g << 8) | b;
      if (k !== lastK) {
        let idx = cache.get(k);
        if (idx === undefined) {
          let bd = Infinity;
          for (const p of pal) { const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < bd) { bd = d; idx = p[3]; } }
          cache.set(k, idx);
        }
        lastK = k; lastI = idx;
      }
      surf[i] = lastI;
    }
  }
  // Satellite
  let sat = null;
  if (files.sat) {
    setBusy("Lecture de l'image satellite…"); await tick();
    const side = Math.min(4096, Math.max(R, fr.imagery || 4096));
    sat = (await imagePixels(files.sat, side, false)).canvas;
    if (surf) {
      // Couleur d'affichage de chaque surface = couleur moyenne du satellite à cet endroit.
      const S = 512, sp = (await imagePixels(sat, S, false)).ctx.getImageData(0, 0, S, S).data;
      const acc = surfaces.map(() => [0, 0, 0, 0]);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const a = acc[surf[Math.floor((y + 0.5) * R / S) * R + Math.floor((x + 0.5) * R / S)]], q = (y * S + x) * 4;
        a[0] += sp[q]; a[1] += sp[q + 1]; a[2] += sp[q + 2]; a[3]++;
      }
      surfaces.forEach((s, i) => { const a = acc[i]; if (a[3] > 20) s.sat = [0, 1, 2].map((c) => Math.round(a[c] / a[3])); });
    }
  }

  setBusy('Construction de la carte…'); await tick();
  if (surfaces) { for (const s of surfaces) delete s._colors; terrain.surfaces = surfaces; }
  terrain.init(N, cell, R);
  if (relief) terrain.loadHeightGrid(relief.data, relief.w, relief.h);
  else terrain.flatAll(10);
  if (surf) { terrain.surf.set(surf); terrain.redrawSurface(0, 0, R - 1, R - 1); }
  terrain.setSat(sat);
  objects.setObjects([]);
  roads.roads = []; roads.rebuild();
  // Modèles déjà utilisés par le projet : ajoutés à la bibliothèque si la source Arma 3 les connaît.
  let added = 0;
  if (a3.count) for (const path of proj.models) {
    const key = a3.resolve(path), name = baseName(path).replace(/\.p3d$/, '');
    if (!key || objects.library.some((e) => e.p3d === key || (e.tbName || '').toLowerCase() === name)) continue;
    await objects.addLibraryEntry({ id: 'a3_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name, tbName: name, cat: guessCategory(key), p3d: key });
    added++;
  }
  Object.assign(state.settings, { name: proj.name, tbOffset: [fr.east, fr.north], satCredit: '', game: state.settings.game === 'dayz' ? 'dayz' : 'arma3' });
  applyGame();
  delete state.settings.geo;
  toolSettings.surface = 0;
  undoStack.length = redoStack.length = 0; saveHandle = null;
  dirtyProject = true;
  resetView(); renderPanel(); renderAssets(); updateInfo();
  document.title = `${proj.name} · TerraForge`;

  report.push(`Carte ${(fr.width / 1000).toLocaleString('fr-FR')} km, relief ${N} × ${N} (cellule ${+cell.toFixed(3)} m).`);
  if (relief) report.push(`Relief : ${relief.w} × ${relief.h} points lus${relief.filled < relief.w * relief.h ? ' (fichier incomplet)' : ''}${relief.w !== N ? `, ramenés à ${N} × ${N}` : ''}.`);
  if (surf) report.push(`Masque : ${surfaces.length} surfaces${files.layers ? ' reprises de layers.cfg' : ' déduites des couleurs du masque'}.`);
  else if (surfaces) report.push(`Surfaces : ${surfaces.length} reprises de layers.cfg (sans masque, tout est peint avec la première).`);
  if (sat) report.push(`Image satellite : chargée en ${sat.width} px.`);
  if (added) report.push(`${added} modèles du projet ajoutés à ta bibliothèque.`);
  if (proj.warnings.length) report.push(`Parties du fichier ignorées : ${proj.warnings.length}.`);
  return report;
}
window.__tfTv = { readTv4p, loadTv4p, openTv4p };

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

// ======================================================================
// Choix du jeu
// ======================================================================
function currentGame() { return gameById(state.settings.game); }
function applyGame() {
  const g = currentGame();
  const chip = document.getElementById('game-chip');
  chip.innerHTML = `<i style="background:${g.color}"></i>${esc(g.name)}`;
  const exp = document.querySelector('#topbar [data-action="export"]');
  exp.lastChild.textContent = ` Exporter pour ${g.name}`;
  exp.title = `Crée les fichiers à importer dans ${g.tool}`;
  for (const k of ['a3', 'eden']) assetsEl.querySelector(`[data-a=${k}]`).style.display = g.rv ? '' : 'none';
  try { localStorage.setItem('tf-game', g.id); } catch { /* stockage indisponible */ }
}
function chooseGame(startup = false) {
  return new Promise((resolve) => {
    let last = state.settings.game;
    try { if (startup) last = localStorage.getItem('tf-game') || last; } catch { /* idem */ }
    const root = document.createElement('div');
    root.id = 'game-pick';
    root.innerHTML = `<div class="gp-box">
      <img class="gp-logo" src="${logoUrl}" alt="TerraForge">
      <h2>Pour quel jeu crées-tu ta carte ?</h2>
      <p class="note">Ce choix règle les surfaces proposées et les fichiers produits à l'export. Tu peux le changer à tout moment avec le bouton du jeu, en haut à gauche.</p>
      <div class="gp-grid">${GAMES.map((g) => `<button data-g="${g.id}" class="${g.id === last ? 'active' : ''}" style="--gc:${g.color}"><b>${esc(g.name)}</b><small>${esc(g.tool)}</small><span>${esc(g.desc)}</span></button>`).join('')}</div>
      ${startup ? '' : '<menu><button data-g="">Annuler</button></menu>'}
    </div>`;
    document.body.append(root);
    for (const b of root.querySelectorAll('[data-g]')) b.onclick = () => {
      root.remove();
      if (b.dataset.g && b.dataset.g !== state.settings.game) { state.settings.game = b.dataset.g; if (!startup) dirtyProject = true; }
      applyGame();
      resolve(b.dataset.g || null);
    };
  });
}
document.getElementById('game-chip').onclick = async () => {
  const before = state.settings.game;
  const g = await chooseGame();
  if (g && g !== before) toast(`Jeu : ${currentGame().name}. Les surfaces de la carte actuelle sont conservées ; « Nouveau terrain » propose celles de ce jeu.`, 5000);
};

async function doExportGame(game) {
  const sizes = HEIGHTMAP_SIZES[game.exp] || HEIGHTMAP_SIZES.generic;
  const v = await formDialog(`Exporter pour ${game.name}`, [
    { key: 'tag', label: 'Nom de la carte', value: state.settings.name || 'MaCarte' },
    { key: 'size', label: 'Précision du relief', type: 'select', value: defaultHeightmapSize(game.exp, terrain.N), options: sizes.map((n) => [n, `${n} × ${n} points (${(terrain.size / n).toFixed(1)} m par point)`]) },
  ], `Crée un .zip avec le relief, les couches de surface, une vue de dessus, les objets, les routes et un mode d'emploi pas à pas pour ${esc(game.tool)}.`, 'Exporter');
  if (!v) return;
  const name = (v.tag || 'MaCarte').trim().replace(/[^A-Za-z0-9_]/g, '_');
  try {
    const zip = await busy('Export en cours…', () => buildGameZip(state, game, { tag: name, size: +v.size }));
    download(zip, `${name}_${game.id}_terraforge.zip`, 'application/zip');
    toast('Export terminé : lis LISEZMOI.txt dans le .zip', 4000);
  } catch (err) {
    console.error(err);
    alertDialog('Export impossible', esc(err.message || String(err)));
  }
}

async function doExport() {
  if (currentGame().exp !== 'tb') return doExportGame(currentGame());
  const v = await formDialog(`Exporter pour ${currentGame().name} (Terrain Builder)`, [
    { key: 'tag', label: 'Nom de la carte / du mod', value: state.settings.name || 'MonTerrain' },
    { key: 'offsetEast', label: 'Easting (décalage X)', type: 'number', value: state.settings.tbOffset?.[0] ?? 200000 },
    { key: 'offsetNorth', label: 'Northing (décalage Y)', type: 'number', value: state.settings.tbOffset?.[1] ?? 0 },
    { key: 'imageScale', label: 'Agrandir sat/masque', type: 'select', value: 1, options: [[1, `×1 (${terrain.maskRes} px)`], [2, `×2 (${terrain.maskRes * 2} px)`], [4, `×4 (${terrain.maskRes * 4} px)`]] },
    { key: 'xyz', label: 'Ajouter aussi un fichier XYZ', type: 'checkbox', value: false },
  ], 'Crée un .zip contenant le dossier du mod à décompresser sur P: : config.cpp, relief (ASC), image satellite et masque (PNG), layers.cfg, liste des objets, routes et mode d\'emploi.', 'Exporter');
  if (!v) return;
  const name = (v.tag || 'MonTerrain').trim().replace(/[^A-Za-z0-9_]/g, '_');
  try {
    const zip = await busy('Export en cours…', () => buildExportZip(state, { ...v, game: state.settings.game, tag: name, author: state.settings.author, geo: state.settings.geo, satCredit: state.settings.satCredit, imageScale: +v.imageScale }));
    download(zip, `${name}_terraforge.zip`, 'application/zip');
    toast('Export terminé');
  } catch (err) {
    console.error(err);
    alertDialog('Export impossible', esc(err.message || String(err)));
  }
}

const IS_APP = /Electron/.test(navigator.userAgent);

// ---------- Pilotage à distance (serveur MCP de l'appli Windows) ----------
// Chaque fonction reçoit un objet d'arguments et renvoie un objet simple (JSON).
const mcpApi = {
  etat() {
    const counts = {};
    for (const o of objects.objects) counts[o.lib] = (counts[o.lib] || 0) + 1;
    const lib = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => {
      const e = objects.entry(id) || {};
      return { id, nom: e.name, modele: e.tbName, vraiModele: !!e.p3d && !e._missing, nombre: n };
    });
    return {
      version: APP_VERSION, jeu: state.settings.game, nom: state.settings.name,
      taille_m: terrain.size, grille: terrain.N, cellule_m: terrain.cell,
      geo: state.settings.geo || null,
      routes: roads.roads.length, objets: objects.objects.length, parModele: lib,
      modelesArma3: a3.count, occupe: busyEl.classList.contains('show'), message: busyEl.querySelector('p')?.textContent || '',
      dialogueOuvert: dlg.open ? (dlgForm.querySelector('h2')?.textContent || true) : false,
    };
  },
  // Lance « Monde réel » sans fenêtre. Renvoie tout de suite ; suivre avec etat() puis dernier_import().
  monde_reel(a = {}) {
    if (busyEl.classList.contains('show')) return { erreur: 'TerraForge est déjà occupé.' };
    document.getElementById('wizard')?.remove();
    if (dlg.open) dlg.close();
    const side = Math.max(1024, Math.min(16384, +a.taille_m || 4096));
    const grid = side >= 8192 ? 2048 : 1024, cell = side / grid;
    const on = (v, d = true) => (v === undefined ? d : !!v);
    const cfg = {
      name: String(a.nom || 'MonTerrainReel').replace(/\W/g, '') || 'MonTerrainReel', author: '',
      lat: +a.lat, lon: +a.lon, grid, cell, maskRes: 2048,
      relief: on(a.relief), altMode: 'real',
      satellite: on(a.satellite), satSource: 'auto', satRes: 4096,
      roads: on(a.routes), paths: on(a.chemins, false), landuse: on(a.sols), trees: on(a.arbres), treeDensity: +a.densite_arbres || 40, buildings: on(a.batiments),
    };
    if (!isFinite(cfg.lat) || !isFinite(cfg.lon)) return { erreur: 'lat et lon sont obligatoires.' };
    const t0 = Date.now();
    mcpApi._import = { enCours: true, cfg: { lat: cfg.lat, lon: cfg.lon, taille_m: side } };
    runGeo(cfg).then(
      (r) => { mcpApi._import = { enCours: false, duree_s: Math.round((Date.now() - t0) / 1000), manquants: r.failed, causes: r.causes, relief: r.relief, avertissement: r.warning, ...mcpApi.etat() }; },
      (err) => { mcpApi._import = { enCours: false, erreur: err.message || String(err) }; },
    );
    return { lance: true };
  },
  dernier_import() { return mcpApi._import || { enCours: false, aucun: true }; },
  fermer_dialogue() { const t = dlg.open ? dlgForm.querySelector('h2')?.textContent : null; if (dlg.open) dlg.close(); document.getElementById('wizard')?.remove(); return { ferme: t }; },
  camera(a = {}) {
    if (isFinite(+a.x) && isFinite(+a.z)) {
      const y = isFinite(+a.hauteur) ? +a.hauteur : terrain.heightAt(+a.x, +a.z) + 150;
      const d = isFinite(+a.distance) ? +a.distance : 250;
      camera.position.set(+a.x - d * 0.6, y, +a.z + d * 0.8);
      controls.target.set(+a.x, terrain.heightAt(+a.x, +a.z), +a.z);
      camera.lookAt(controls.target);
      controls.update?.();
    }
    return { position: camera.position.toArray().map((v) => Math.round(v)), cible: controls.target.toArray().map((v) => Math.round(v)) };
  },
  // Exécute du JavaScript dans l'éditeur (diagnostic). `code` est le corps d'une fonction asynchrone.
  async js(a = {}) {
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)('tf', String(a.code || ''));
    const out = await fn({ state, terrain, objects, roads, a3, camera, controls, api: mcpApi, geo: window.__tfGeo });
    return { resultat: out === undefined ? null : out };
  },
};

function doHelp() {
  alertDialog('Aide TerraForge', `
  <img class="help-logo" src="${logoUrl}" alt="TerraForge">
  <ul>
    <li><b>Vue (caméra libre)</b> : maintiens le clic droit pour regarder autour de toi, ZQSD pour te déplacer, A / E pour descendre / monter, molette pour avancer / reculer, Maj pour aller plus vite. Clic molette : glisser la vue.</li>
    <li><b>Touches 1 à 9, 0</b> : changer d'outil. <b>[ ]</b> : taille du pinceau. <b>Ctrl+Z / Ctrl+Y</b> : annuler / rétablir. <b>Ctrl+S</b> : enregistrer.</li>
    <li><b>Relief</b> : clic pour monter, Maj+clic pour descendre. <b>Aplanir</b> : Ctrl+clic pour prendre l'altitude.</li>
    <li><b>Forêt</b> : règle le mélange d'essences, la densité et l'échelle, puis peins. Maj pour gommer.</li>
    <li><b>Routes</b> : clic pour poser des points, double-clic pour terminer.</li>
    <li><b>Monde réel</b> crée la carte à partir d'un vrai lieu : relief, routes, forêts, eau et bâtiments.</li>
    <li><b>Nouveau terrain</b> ouvre l'assistant : taille, style de relief, mer, rivières, volcan, canyon, surfaces.</li>
    <li><b>Exporter</b> produit un .zip contenant le dossier du mod, à décompresser sur P: ; le fichier LISEZMOI.txt explique chaque étape.</li>
  </ul>
  <p class="note">La compilation finale du terrain (WRP + PBO) se fait toujours avec les outils Arma 3 (Terrain Builder, Addon Builder ou pboProject).</p>
  ${IS_APP ? '<p><button type="button" id="btn-claude">Connecter TerraForge à Claude</button> <span class="note">Permet à Claude (appli de bureau) de piloter TerraForge.</span></p>' : ''}`);
  const bc = document.getElementById('btn-claude');
  if (bc) bc.onclick = () => window.open('terraforge-cmd:connect-claude');
}

document.getElementById('topbar').addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.action;
  ({ new: () => doNew(), geo: doGeo, open: doOpen, save: () => doSave(), 'import-hm': doImportHeightmap, export: doExport, undo, redo, help: doHelp })[a]?.();
});
window.addEventListener('beforeunload', (e) => { if (dirtyProject) { e.preventDefault(); e.returnValue = ''; } });

// ======================================================================
// Barre d'état
// ======================================================================
const stPos = document.getElementById('st-pos');
const stInfo = document.getElementById('st-info');
const hudRead = document.getElementById('hud-readout');
function updateStatus() {
  if (!hover) {
    stPos.textContent = '—';
    if (hudRead) hudRead.textContent = 'X —   Y —   Alt. —';
    return;
  }
  const x = hover.x.toFixed(0), y = terrain.north(hover.z).toFixed(0);
  const alt = hover.y.toFixed(1), slope = terrain.slopeAt(hover.x, hover.z).toFixed(0);
  stPos.textContent = `X ${x}  Y ${y}  Alt. ${alt} m  Pente ${slope}°`;
  if (hudRead) hudRead.textContent = `X ${x}   Y ${y}   Alt. ${alt} m   Pente ${slope}°`;
}
const hudRose = document.getElementById('hud-rose');
const hudScaleBar = document.getElementById('hud-scale-bar');
const hudScaleLabel = document.getElementById('hud-scale-label');
const _hudOffset = new THREE.Vector3();
let lastScaleLabel = '';
function updateHud() {
  if (!hudRose) return;
  _hudOffset.copy(camera.position).sub(controls.target);
  _hudOffset.y = 0;
  if (_hudOffset.lengthSq() > 4) {
    const az = Math.atan2(_hudOffset.x, _hudOffset.z);
    hudRose.style.transform = `rotate(${-az}rad)`;
  }
  const dist = Math.max(1, camera.position.distanceTo(controls.target));
  const pxH = Math.max(1, renderer.domElement.clientHeight);
  const mPerPx = (2 * Math.tan((camera.fov * Math.PI) / 360) * dist) / pxH;
  const raw = Math.max(1, mPerPx * 96);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  const meters = nice * pow;
  if (hudScaleBar) hudScaleBar.style.width = Math.max(28, Math.min(130, meters / mPerPx)).toFixed(0) + 'px';
  const label = meters >= 1000
    ? `${(meters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: meters >= 10000 ? 0 : 1 })} km`
    : `${Math.round(meters).toLocaleString('fr-FR')} m`;
  if (hudScaleLabel && label !== lastScaleLabel) { lastScaleLabel = label; hudScaleLabel.textContent = label; }
}
function syncChrome() {
  const gap = 10, topH = 52, statusH = 32;
  const toolsW = document.body.classList.contains('tools-collapsed') ? 36 : 72;
  const panelW = document.body.classList.contains('panel-collapsed') ? 36 : 300;
  const assetsH = assetsEl.classList.contains('closed') ? 34 : (parseInt(assetsEl.style.height, 10) || 214);
  const root = document.documentElement;
  root.style.setProperty('--tools-w', toolsW + 'px');
  root.style.setProperty('--panel-w', panelW + 'px');
  root.style.setProperty('--assets-h', assetsH + 'px');
  root.style.setProperty('--chrome-top', `${gap + topH + 8}px`);
  root.style.setProperty('--chrome-left', `${gap + toolsW + 8}px`);
  root.style.setProperty('--chrome-right', `${gap + panelW + 8}px`);
  root.style.setProperty('--chrome-bottom', `${gap + statusH + assetsH + 8}px`);
  resize();
}
function updateInfo() {
  stInfo.textContent = `${objects.objects.length.toLocaleString('fr-FR')} objets · ${roads.roads.length} routes`;
}

let toastTimer;
const toastEl = document.createElement('div');
toastEl.id = 'toast';
toastEl.innerHTML = '<i></i><span></span>';
viewport.append(toastEl);
function toast(msg, ms = 2200) {
  toastEl.querySelector('span').textContent = msg;
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
  await objects.setLibrary([]);
  syncChrome();
  resize();
  setTool('raise');
  renderAssets();
  createMap({ name: 'MonTerrain', author: '', grid: 512, cell: 8, maskRes: 1024, surfaces: terrain.surfaces, params: defaultParams() });
  loop();
  window.__tf = state; // pratique pour le débogage dans la console
  window.__tfCreate = createMap;
  window.__tfGeo = { buildGeoMap, fetchElevation, fetchOSM, parseOSM, placeBuildings, placeBridges, bridgeShape };
  window.__tfDefaults = defaultParams;
  window.__tfMcp = mcpApi;
  window.__tfA3 = { a3, connectA3, useA3Model, camera, controls, parseObjectLines };
  if (!new URLSearchParams(location.search).has('nowizard')) chooseGame(true).then(() => doNew(true));
})();

document.getElementById('brand').insertAdjacentHTML('afterbegin', LOGO);
