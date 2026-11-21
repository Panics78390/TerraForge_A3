import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STYLES, defaultParams, applyStyle, generate, colorize } from './gen.js';
import { SURFACE_SETS } from './surfaces.js';
import { icon } from './icons.js';

// Tailles de carte proposées : côté (m) -> grille d'altitude et taille de cellule.
export const MAP_SIZES = [
  { side: 2048,  grid: 512,  cell: 4,    label: '2 km' },
  { side: 4096,  grid: 1024, cell: 4,    label: '4 km' },
  { side: 8192,  grid: 2048, cell: 4,    label: '8 km · Stratis' },
  { side: 10240, grid: 2048, cell: 5,    label: '10 km' },
  { side: 12800, grid: 2048, cell: 6.25, label: '12,8 km · Malden' },
  { side: 15360, grid: 2048, cell: 7.5,  label: '15 km · Tanoa' },
  { side: 30720, grid: 4096, cell: 7.5,  label: '30 km · Altis (très lourd)' },
];

const PV = 256; // résolution de l'aperçu
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function openWizard() {
  return new Promise((resolve) => {
    const cfg = {
      name: 'MonTerrain',
      author: '',
      sizeIdx: 1,
      grid: 1024, cell: 4,
      maskRes: 2048,
      surfaceSet: 'altis',
      surfaceOn: null,
      params: defaultParams(),
    };
    let page = 'general';
    let view = '2d';
    let pv = null;          // dernier résultat d'aperçu
    let three = null;       // aperçu 3D (créé à la demande)
    let pending = false;

    const root = document.createElement('div');
    root.id = 'wizard';
    root.innerHTML = `
      <div class="wz-box">
        <header class="wz-head">
          <div class="brand">${LOGO}<b>Terra<span>Forge</span></b></div>
          <div class="wz-title">Nouvelle carte</div>
        </header>
        <nav class="wz-nav"></nav>
        <section class="wz-main"></section>
        <footer class="wz-foot">
          <div class="wz-sum"></div>
          <div class="spacer"></div>
          <button data-a="cancel">Annuler</button>
          <button data-a="create" class="primary">${icon('check', 14)} Créer la carte</button>
        </footer>
      </div>`;
    document.body.append(root);
    const nav = root.querySelector('.wz-nav'), main = root.querySelector('.wz-main'), sum = root.querySelector('.wz-sum');

    const PAGES = [
      ['general', '① Général'],
      ['map', '② Taille de la carte'],
      ['terrain', '③ Terrain'],
      ['surfaces', '④ Surfaces'],
    ];

    const size = () => cfg.grid * cfg.cell;
    const surfaces = () => {
      const set = SURFACE_SETS[cfg.surfaceSet].surfaces;
      if (!cfg.surfaceOn) cfg.surfaceOn = Object.fromEntries(set.map((s) => [s.id, true]));
      return set.filter((s) => cfg.surfaceOn[s.id]);
    };

    function close(result) {
      if (three) { three.renderer.dispose(); three = null; }
      root.remove();
      resolve(result);
    }
    root.querySelector('[data-a=cancel]').onclick = () => close(null);
    root.querySelector('[data-a=create]').onclick = () => {
      const name = cfg.name.trim().replace(/[^A-Za-z0-9_]/g, '_') || 'MonTerrain';
      const list = surfaces();
      close({ ...cfg, name, surfaces: (list.length ? list : SURFACE_SETS[cfg.surfaceSet].surfaces).map((s) => ({ ...s })) });
    };

    function renderNav() {
      nav.innerHTML = '';
      for (const [id, label] of PAGES) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = id === page ? 'active' : '';
        b.onclick = () => { page = id; render(); };
        nav.append(b);
      }
    }
    function renderSum() {
      const px = size() / cfg.maskRes;
      sum.innerHTML = `<b>${esc(cfg.name)}</b> · Carte ${size().toLocaleString('fr-FR')} m · Relief ${cfg.grid} × ${cfg.grid}, cellule ${cfg.cell} m · Sat/masque ${cfg.maskRes} px (${px.toFixed(1)} m/px) · ${surfaces().length} surfaces`;
    }

    // ---------- petits constructeurs ----------
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
    function slider(label, obj, key, min, max, step, unit = '', tip = '') {
      const row = el('div', 'row');
      row.title = tip;
      row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${obj[key]}"><output>${obj[key]}${unit}</output>`;
      const inp = row.querySelector('input'), out = row.querySelector('output');
      inp.oninput = () => { obj[key] = parseFloat(inp.value); out.textContent = inp.value + unit; schedule(); };
      return row;
    }
    function textRow(label, obj, key, type = 'text', onchange) {
      const row = el('div', 'row');
      row.innerHTML = `<label>${label}</label><input type="${type}" value="${esc(obj[key])}">`;
      row.querySelector('input').oninput = (e) => {
        obj[key] = type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value;
        onchange?.(); renderSum();
      };
      return row;
    }
    // Bloc repliable avec interrupteur (comme « Mer et côtes »).
    function toggleBlock(title, sub, obj, key, build) {
      const box = el('div', 'wz-block' + (obj[key] ? ' on' : ''));
      box.innerHTML = `<label class="wz-block-head"><div><b>${title}</b><small>${sub}</small></div><input type="checkbox" class="switch" ${obj[key] ? 'checked' : ''}></label><div class="wz-block-body"></div>`;
      const body = box.querySelector('.wz-block-body');
      const fill = () => { body.innerHTML = ''; if (obj[key] && build) build(body); };
      box.querySelector('input').onchange = (e) => { obj[key] = e.target.checked; box.classList.toggle('on', obj[key]); fill(); schedule(); };
      fill();
      return box;
    }

    // ---------- pages ----------
    function pageGeneral() {
      main.innerHTML = '';
      const c = el('div', 'wz-col');
      c.append(el('h2', '', 'Général'), el('p', 'note', 'Donne un nom à ta carte. Il sert de nom de dossier du mod et de nom de monde dans Arma 3 (lettres, chiffres et _ uniquement).'));
      c.append(textRow('Nom de la carte', cfg, 'name', 'text', drawTree), textRow('Auteur', cfg, 'author'));
      c.append(el('h3', '', 'Ce qui sera créé à l\'export'));
      const tree = el('pre', 'wz-tree');
      c.append(tree);
      function drawTree() {
        const n = cfg.name.trim().replace(/[^A-Za-z0-9_]/g, '_') || 'MonTerrain';
        tree.textContent =
`P:\\${n}\\
 ├─ config.cpp              configuration du monde (base à compléter)
 ├─ data\\roads\\            routes (shapefile) + RoadsLib.cfg
 └─ source\\
     ├─ ${n}.asc            relief pour Terrain Builder
     ├─ ${n}_sat.png        image satellite
     ├─ ${n}_mask.png       masque de surfaces
     ├─ layers.cfg          couches de surfaces
     └─ ${n}_objets.txt     objets à importer`;
      }
      drawTree();
      main.append(c);
    }

    function pageMap() {
      main.innerHTML = '';
      const c = el('div', 'wz-col');
      c.append(el('h2', '', 'Taille de la carte'), el('p', 'note', 'Choisis la longueur du côté. Le relief, l\'image satellite et le masque sont réglés pour correspondre. Les repères indiquent la taille de cartes connues.'));
      const chips = el('div', 'wz-chips');
      MAP_SIZES.forEach((m, i) => {
        const b = el('button', i === cfg.sizeIdx ? 'active' : '', `<b>${m.side}</b><small>${m.label}</small>`);
        b.onclick = () => { cfg.sizeIdx = i; cfg.grid = m.grid; cfg.cell = m.cell; pv = null; render(); };
        chips.append(b);
      });
      c.append(chips);
      c.append(el('h3', '', 'Réglages avancés'));
      const g = el('div', 'row');
      g.innerHTML = `<label>Grille d'altitude</label><select>${[512, 1024, 2048, 4096].map((v) => `<option ${v === cfg.grid ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
      g.querySelector('select').onchange = (e) => { cfg.grid = +e.target.value; cfg.sizeIdx = -1; pv = null; render(); };
      c.append(g);
      c.append(textRow('Taille de cellule (m)', cfg, 'cell', 'number', () => { cfg.sizeIdx = -1; cfg.cell = Math.max(0.5, cfg.cell); pv = null; info(); }));
      const mr = el('div', 'row');
      mr.innerHTML = `<label>Sat / masque dans l'éditeur</label><select>${[1024, 2048, 4096].map((v) => `<option value="${v}" ${v === cfg.maskRes ? 'selected' : ''}>${v} px</option>`).join('')}</select>`;
      mr.querySelector('select').onchange = (e) => { cfg.maskRes = +e.target.value; info(); renderSum(); };
      c.append(mr);
      const box = el('div', 'wz-info');
      c.append(el('h3', '', 'Ce qui sera créé'), box);
      function info() {
        const heavy = cfg.grid >= 4096 ? '<p class="warn">Grille 4096 : la création prend plusieurs dizaines de secondes et demande beaucoup de mémoire.</p>' : '';
        box.innerHTML = `<table>
          <tr><td>Carte</td><td>${size().toLocaleString('fr-FR')} × ${size().toLocaleString('fr-FR')} m</td></tr>
          <tr><td>Relief</td><td>${cfg.grid} × ${cfg.grid}, cellule ${cfg.cell} m</td></tr>
          <tr><td>Sat, masque</td><td>${cfg.maskRes} px dans l'éditeur (${(size() / cfg.maskRes).toFixed(2)} m/px), agrandissable ×2 ou ×4 à l'export</td></tr>
        </table>${heavy}`;
      }
      info();
      main.append(c);
    }

    function pageTerrain() {
      const P = cfg.params;
      const scroll = main.querySelector('.wz-terrain .wz-col')?.scrollTop || 0;
      main.innerHTML = '';
      const wrap = el('div', 'wz-terrain');
      const left = el('div', 'wz-col');
      const right = el('div', 'wz-preview');
      wrap.append(left, right);
      main.append(wrap);

      left.append(el('h2', '', 'Terrain'), el('p', 'note', 'Choisis un style de départ puis ajuste. L\'aperçu se met à jour en direct. Ensuite, c\'est un terrain normal que tu peux continuer à modifier.'));
      const cards = el('div', 'wz-styles');
      for (const [id, st] of Object.entries(STYLES)) {
        const card = el('button', id === P.style ? 'active' : '', `<canvas width="72" height="72"></canvas><small>${st.name}</small>`);
        card.dataset.style = id;
        card.onclick = () => { applyStyle(P, id); pageTerrain(); schedule(); };
        cards.append(card);
      }
      left.append(cards);

      left.append(slider('Point le plus bas (m)', P, 'low', 0, 200, 1, '', 'Altitude de base des terres'));
      left.append(slider('Dénivelé (m)', P, 'diff', 0, 1500, 10, '', 'Écart entre le point le plus bas et le plus haut'));
      left.append(slider('Taille des reliefs (m)', P, 'landform', 400, 6000, 10, '', 'Distance typique entre deux collines ou montagnes'));
      left.append(slider('Rugosité', P, 'rough', 0, 100, 1, ' %', 'Petits détails du relief'));
      left.append(slider('Crêtes', P, 'ridges', 0, 100, 1, ' %', 'Arêtes marquées comme en montagne'));
      left.append(slider('Érosion', P, 'erosion', 0, 100, 1, ' %', 'Adoucit les pentes comme l\'eau le ferait'));
      const seed = el('div', 'row');
      seed.innerHTML = `<label>Graine</label><input type="number" value="${P.seed}"><button class="small">${icon('dice', 14)} Variante</button>`;
      seed.querySelector('input').oninput = (e) => { P.seed = parseInt(e.target.value, 10) || 1; schedule(); };
      seed.querySelector('button').onclick = () => { P.seed = Math.floor(Math.random() * 99999); seed.querySelector('input').value = P.seed; schedule(); };
      left.append(seed);

      left.append(toggleBlock('Mer et côtes', 'Île, presqu\'île, côte ou archipel', P.sea, 'on', (b) => {
        const modes = el('div', 'wz-chips small');
        for (const [id, label] of [['island', 'Île'], ['peninsula', 'Presqu\'île'], ['coast', 'Côte'], ['archipelago', 'Archipel']]) {
          const m = el('button', P.sea.mode === id ? 'active' : '', icon(id, 16) + label);
          m.onclick = () => { P.sea.mode = id; pageTerrain(); schedule(); };
          modes.append(m);
        }
        b.append(modes);
        if (P.sea.mode === 'peninsula' || P.sea.mode === 'coast')
          b.append(slider('Côté du continent', P.sea, 'dir', 0, 345, 15, '°', '0° = nord, 90° = est, 180° = sud, 270° = ouest'));
        b.append(slider('Part de terre', P.sea, 'landmass', 10, 95, 1, ' %'));
        const cs = el('div', 'row');
        cs.innerHTML = `<label>Forme de la côte</label><input type="number" value="${P.sea.seed}"><button class="small" title="Autre forme">${icon('dice', 14)}</button>`;
        cs.querySelector('input').oninput = (e) => { P.sea.seed = parseInt(e.target.value, 10) || 1; schedule(); };
        cs.querySelector('button').onclick = () => { P.sea.seed = Math.floor(Math.random() * 99999); cs.querySelector('input').value = P.sea.seed; schedule(); };
        b.append(cs);
      }));

      left.append(toggleBlock('Rivières', 'Clique dans l\'aperçu 2D pour poser une source, l\'eau trouve son chemin', P.rivers, 'on', (b) => {
        b.append(slider('Largeur (m)', P.rivers, 'width', 4, 60, 1));
        b.append(slider('Profondeur de vallée (m)', P.rivers, 'depth', 1, 40, 0.5));
        b.append(slider('Rivières automatiques', P.rivers, 'auto', 0, 12, 1));
        const r = el('div', 'row');
        r.innerHTML = `<span class="note" data-count></span><button class="small">Tout retirer</button>`;
        r.querySelector('button').onclick = () => { P.rivers.springs = []; schedule(); pageTerrain(); };
        r.querySelector('[data-count]').textContent = `${P.rivers.springs.length} source(s) posée(s). Clic droit dans l'aperçu : retirer la plus proche.`;
        b.append(r);
        b.append(el('p', 'note', 'Dans Arma 3, seule l\'eau sous 0 m est gérée nativement. Les rivières creusent ici leur vallée et leur lit ; l\'eau en altitude demande des objets « étang ».'));
      }));

      left.append(toggleBlock('Peindre le sol', 'Plage, roche, terre et herbe selon l\'altitude et la pente', P, 'paint'));

      left.append(toggleBlock('Volcan', 'Montagne conique avec cratère', P.shapes.volcano, 'on', (b) => {
        const v = P.shapes.volcano;
        b.append(slider('Hauteur (m)', v, 'height', 50, 1500, 10), slider('Taille', v, 'size', 4, 40, 1, ' %'));
        b.append(slider('Position ouest-est', v, 'x', 0, 100, 1, ' %'), slider('Position nord-sud', v, 'y', 0, 100, 1, ' %'));
        b.append(slider('Cratère', v, 'crater', 0, 50, 1, ' %'), slider('Profondeur du cratère', v, 'craterDepth', 0, 80, 1, ' %'));
        b.append(slider('Pentes', v, 'slopes', 0, 100, 1, ' %'), slider('Ravines', v, 'gullies', 0, 100, 1, ' %'));
      }));
      left.append(toggleBlock('Canyon', 'Gorge sinueuse à travers la carte', P.shapes.canyon, 'on', (b) => {
        const c = P.shapes.canyon;
        b.append(slider('Profondeur (m)', c, 'depth', 10, 400, 5), slider('Largeur (m)', c, 'width', 30, 800, 10));
        b.append(slider('Méandres', c, 'bends', 0, 100, 1, ' %'), slider('Direction', c, 'dir', 0, 175, 5, '°'), slider('Décalage', c, 'offset', -100, 100, 1, ' %'));
      }));
      left.append(toggleBlock('Plateaux', 'Paliers plats avec bords en falaise', P.shapes.plateaus, 'on', (b) => {
        b.append(slider('Hauteur des paliers (m)', P.shapes.plateaus, 'step', 10, 200, 5));
      }));
      left.append(toggleBlock('Cratère', 'Creux rond avec un rebord', P.shapes.crater, 'on', (b) => {
        const c = P.shapes.crater;
        b.append(slider('Taille', c, 'size', 2, 30, 1, ' %'), slider('Profondeur (m)', c, 'depth', 5, 400, 5));
        b.append(slider('Position ouest-est', c, 'x', 0, 100, 1, ' %'), slider('Position nord-sud', c, 'y', 0, 100, 1, ' %'));
      }));

      right.innerHTML = `
        <div class="wz-tabs"><button data-v="2d">${icon('grid2d', 14)} 2D · vue de dessus</button><button data-v="3d">${icon('cube3d', 14)} 3D · orientable</button></div>
        <div class="wz-view"><canvas class="pv2d" width="${PV}" height="${PV}"></canvas><canvas class="pv3d"></canvas></div>
        <p class="note pv-info"></p>`;
      right.querySelectorAll('.wz-tabs button').forEach((b) => {
        b.classList.toggle('active', b.dataset.v === view);
        b.onclick = () => { view = b.dataset.v; pageTerrain(); };
      });
      const c2 = right.querySelector('.pv2d'), c3 = right.querySelector('.pv3d');
      c2.style.display = view === '2d' ? '' : 'none';
      c3.style.display = view === '3d' ? '' : 'none';
      if (three) { three.renderer.dispose(); three = null; }

      const uvOf = (e) => { const r = c2.getBoundingClientRect(); return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height }; };
      c2.onclick = (e) => {
        if (!P.rivers.on) return;
        if (P.rivers.springs.length >= 12) return;
        P.rivers.springs.push(uvOf(e));
        schedule(); pageTerrain();
      };
      c2.oncontextmenu = (e) => {
        e.preventDefault();
        if (!P.rivers.on || !P.rivers.springs.length) return;
        const p = uvOf(e);
        let bi = 0, bd = Infinity;
        P.rivers.springs.forEach((s, i) => { const d = Math.hypot(s.u - p.u, s.v - p.v); if (d < bd) { bd = d; bi = i; } });
        P.rivers.springs.splice(bi, 1);
        schedule(); pageTerrain();
      };
      c2.style.cursor = P.rivers.on ? 'crosshair' : 'default';
      left.scrollTop = scroll;
      drawPreview();
    }

    function pageSurfaces() {
      main.innerHTML = '';
      const c = el('div', 'wz-col wide');
      c.append(el('h2', '', 'Surfaces'), el('p', 'note', 'Les types de sol de la carte. Ils produisent le fichier layers.cfg et le masque. Arma 3 accepte au maximum 6 surfaces par tuile de terrain : garde une palette raisonnable.'));
      const sets = el('div', 'wz-chips');
      for (const [id, s] of Object.entries(SURFACE_SETS)) {
        const b = el('button', id === cfg.surfaceSet ? 'active' : '', `<b>${s.name}</b><small>${s.note}</small>`);
        b.onclick = () => { cfg.surfaceSet = id; cfg.surfaceOn = null; render(); };
        sets.append(b);
      }
      c.append(sets);
      const list = el('div', 'wz-surf');
      surfaces();
      for (const s of SURFACE_SETS[cfg.surfaceSet].surfaces) {
        const it = el('label', 'item', `<input type="checkbox" ${cfg.surfaceOn[s.id] ? 'checked' : ''}><span class="sw" style="background:rgb(${s.sat})"></span><div class="grow">${esc(s.name)}<div class="sub">${esc(s.rvmat || s.id)}</div></div><span class="sw" title="Couleur dans le masque" style="background:rgb(${s.mask})"></span>`);
        it.querySelector('input').onchange = (e) => { cfg.surfaceOn[s.id] = e.target.checked; renderSum(); };
        list.append(it);
      }
      c.append(list);
      main.append(c);
    }

    // ---------- aperçu ----------
    function schedule() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; pv = null; if (page === 'terrain') drawPreview(); });
    }

    function compute() {
      if (pv) return pv;
      const t0 = performance.now();
      const r = generate(cfg.params, PV, size());
      const rgba = new Uint8ClampedArray(PV * PV * 4);
      colorize(r.heights, PV, size(), cfg.params.paint, rgba);
      let min = Infinity, max = -Infinity;
      for (const h of r.heights) { if (h < min) min = h; if (h > max) max = h; }
      pv = { ...r, rgba, min, max, ms: performance.now() - t0 };
      return pv;
    }

    function drawPreview() {
      const r = compute();
      const c2 = main.querySelector('.pv2d');
      if (!c2) return;
      main.querySelector('.pv-info').textContent = `Aperçu : ${(size() / 1000).toFixed(1)} km de côté · altitudes de ${r.min.toFixed(0)} à ${r.max.toFixed(0)} m`;
      // vignettes de style
      main.querySelectorAll('.wz-styles button').forEach((b) => {
        const T = 72, P2 = structuredClone(cfg.params);
        applyStyle(P2, b.dataset.style);
        const g = generate(P2, T, size(), { rivers: false });
        const px = new Uint8ClampedArray(T * T * 4);
        colorize(g.heights, T, size(), P2.paint, px);
        b.querySelector('canvas').getContext('2d').putImageData(new ImageData(px, T, T), 0, 0);
      });
      if (view === '2d') {
        const ctx = c2.getContext('2d');
        ctx.putImageData(new ImageData(r.rgba, PV, PV), 0, 0);
        const k = PV / size();
        ctx.lineJoin = ctx.lineCap = 'round';
        for (const riv of r.rivers) {
          ctx.strokeStyle = '#4aa3df'; ctx.lineWidth = 1.6;
          ctx.beginPath();
          riv.forEach(([x, z], i) => (i ? ctx.lineTo(x * k, z * k) : ctx.moveTo(x * k, z * k)));
          ctx.stroke();
        }
        for (const s of cfg.params.rivers.on ? cfg.params.rivers.springs : []) {
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1d6fa5'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(s.u * PV, s.v * PV, 3, 0, 7); ctx.fill(); ctx.stroke();
        }
      } else draw3D(r);
    }

    function draw3D(r) {
      const canvas = main.querySelector('.pv3d');
      if (!three) {
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        const w = canvas.clientWidth || 480, h = canvas.clientHeight || 480;
        renderer.setSize(w, h, false);
        renderer.setPixelRatio(Math.min(2, devicePixelRatio));
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#141a21');
        const cam = new THREE.PerspectiveCamera(40, w / h, 0.01, 50);
        cam.position.set(0.9, 0.9, 1.3);
        const ctl = new OrbitControls(cam, canvas);
        ctl.target.set(0, 0, 0);
        ctl.maxPolarAngle = Math.PI * 0.49;
        const geo = new THREE.PlaneGeometry(1, 1, PV - 1, PV - 1).rotateX(-Math.PI / 2);
        const tex = new THREE.DataTexture(new Uint8Array(PV * PV * 4), PV, PV);
        tex.colorSpace = THREE.SRGBColorSpace;
        const uv = geo.attributes.uv; // la première ligne des données est le nord
        for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k));
        tex.magFilter = THREE.LinearFilter;
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
        scene.add(mesh);
        const sea = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#2b6c8c', transparent: true, opacity: 0.75 }));
        scene.add(sea);
        three = { renderer, scene, cam, ctl, geo, tex, mesh, sea };
        const draw = () => renderer.render(scene, cam);
        ctl.addEventListener('change', draw);
        three.draw = draw;
      }
      const pos = three.geo.attributes.position;
      for (let k = 0; k < PV * PV; k++) pos.setY(k, r.heights[k] / size());
      pos.needsUpdate = true;
      three.tex.image.data.set(r.rgba);
      three.tex.needsUpdate = true;
      three.sea.visible = cfg.params.sea.on || r.min < 0;
      three.ctl.update();
      three.draw();
    }

    function render() {
      renderNav();
      renderSum();
      ({ general: pageGeneral, map: pageMap, terrain: pageTerrain, surfaces: pageSurfaces })[page]();
    }
    render();
  });
}

export const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 29 9.5v13L16 30 3 22.5v-13z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 21l6-9 3.5 5 2.5-3.5 6 7.5z" fill="currentColor"/></svg>`;
