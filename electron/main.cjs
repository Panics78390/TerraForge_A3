// Application de bureau : une simple fenêtre qui affiche l'éditeur (dist-single/index.html).
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

let mainWin = null;
const logLines = []; // derniers messages de la console de l'éditeur

function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 650,
    backgroundColor: '#070b14',
    title: 'TerraForge',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  mainWin = win;
  win.webContents.on('console-message', (_e, level, message, line) => {
    if (level < 2) return; // avertissements et erreurs seulement
    logLines.push(`${new Date().toISOString().slice(11, 19)} ${level === 3 ? 'ERREUR' : 'attention'} ${String(message).slice(0, 500)} (ligne ${line})`);
    if (logLines.length > 300) logLines.shift();
  });
  Menu.setApplicationMenu(null);
  // Écran de démarrage : le logo, le temps que l'éditeur se charge.
  const splash = new BrowserWindow({ width: 720, height: 480, frame: false, resizable: false, center: true, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#050910', icon: path.join(__dirname, '..', 'build', 'icon.png') });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  const started = Date.now();
  win.once('ready-to-show', () => setTimeout(() => {
    win.maximize();
    win.show();
    if (!splash.isDestroyed()) splash.close();
  }, Math.max(0, 1800 - (Date.now() - started))));
  win.loadFile(path.join(__dirname, '..', 'dist-single', 'index.html'));

  // Liens externes (aide, crédits) : dans le navigateur, pas dans l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'terraforge-cmd:connect-claude') connectClaude(win);
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Travail non enregistré : demander avant de fermer.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Quitter sans enregistrer', 'Annuler'], defaultId: 1, cancelId: 1,
      title: 'TerraForge', message: 'Des modifications ne sont pas enregistrées.', detail: 'Quitter quand même ?',
    });
    if (choice === 0) event.preventDefault();
  });
  // F11 : plein écran, F12 : outils de diagnostic, Ctrl+R : recharger.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });
}

// Serveurs OpenStreetMap (Overpass) : certains refusent les demandes venant d'une appli
// de bureau (origine « file:// », refus 403 ou 406). On les envoie donc comme un client
// normal, identifié par le nom de l'application, sans en-tête d'origine, et on autorise
// la page à lire la réponse.
function setupOverpass() {
  const { session } = require('electron');
  const filter = { urls: ['https://*/api/interpreter*', 'https://*/osm/tools/overpass/*'] };
  const ua = `TerraForge/${app.getVersion()} (desktop map editor)`;
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) if (/^(origin|referer|sec-fetch-.*|sec-ch-.*)$/i.test(k)) delete h[k];
    h['User-Agent'] = ua;
    h['Accept'] = 'application/json, */*';
    cb({ requestHeaders: h });
  });
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
    const h = details.responseHeaders || {};
    for (const k of Object.keys(h)) if (/^access-control-allow-origin$/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: h });
  });
}

// ---------- Pilotage par Claude (MCP) ----------
// TerraForge écoute sur 127.0.0.1 (jamais sur le réseau), avec un jeton secret écrit
// dans son dossier de données. Le pont MCP (mcp-bridge.cjs), lancé par l'appli Claude,
// lit ce jeton et transmet les commandes.
const infoFile = () => path.join(app.getPath('userData'), 'mcp.json');
const bridgeFile = () => (app.isPackaged ? path.join(process.resourcesPath, 'mcp-bridge.cjs') : path.join(__dirname, 'mcp-bridge.cjs'));

async function runTool(tool, args) {
  const win = mainWin;
  if (!win || win.isDestroyed()) throw new Error('fenêtre TerraForge fermée');
  if (tool === 'journal') return { result: logLines.slice(-Math.max(1, Math.min(300, +args.max || 60))) };
  if (tool === 'capture') {
    let img = await win.webContents.capturePage();
    const max = Math.max(320, Math.min(2000, +args.largeur || 1280));
    if (img.getSize().width > max) img = img.resize({ width: max, quality: 'good' });
    return { image: img.toJPEG(72).toString('base64') };
  }
  if (!/^[a-z_]+$/.test(tool) || tool.startsWith('_')) throw new Error('outil inconnu');
  const code = `(async () => { const f = window.__tfMcp && window.__tfMcp[${JSON.stringify(tool)}]; if (typeof f !== 'function') throw new Error('outil indisponible (éditeur pas encore prêt)'); return JSON.parse(JSON.stringify(await f(${JSON.stringify(args || {})}) ?? null)); })()`;
  // Réponse garantie en moins d'une minute, même si l'éditeur est occupé à construire une carte.
  const late = new Promise((_r, reject) => setTimeout(() => reject(new Error("l'éditeur est occupé et n'a pas répondu en 60 s (réessaie dans un instant)")), 60000));
  return { result: await Promise.race([win.webContents.executeJavaScript(code, true), late]) };
}

function startControlServer() {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || req.url !== '/call' || req.headers['x-terraforge-token'] !== token || req.headers.origin) return reply(403, { error: 'refusé' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 2e6) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      try {
        const { tool, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply(200, await runTool(String(tool), args || {}));
      } catch (err) { reply(200, { error: String((err && err.message) || err) }); }
    });
  });
  server.on('error', (err) => console.error('MCP', err));
  server.listen(0, '127.0.0.1', () => {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    try { fs.writeFileSync(infoFile(), JSON.stringify({ port: server.address().port, token, exe, pid: process.pid })); }
    catch (err) { console.error('MCP', err); }
  });
}

// Inscrit TerraForge dans la configuration de l'appli Claude (bouton de l'aide).
function connectClaude(win) {
  const say = (type, message, detail) => dialog.showMessageBox(win, { type, title: 'TerraForge', message, detail, buttons: ['OK'] });
  if (!app.isPackaged) return say('info', 'Disponible seulement dans la version installée.');
  if (process.env.PORTABLE_EXECUTABLE_FILE) return say('warning', 'Utilise la version installée', 'La version portable ne peut pas être branchée à Claude. Installe TerraForge avec le fichier TerraForge-Installation, puis recommence.');
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Claude'));
  try {
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    for (const d of fs.readdirSync(pk)) if (/^(AnthropicPBC\.)?Claude/i.test(d)) dirs.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude'));
  } catch { /* pas d'installation par le Microsoft Store */ }
  // Versions récentes de l'appli Claude : données dans %LOCALAPPDATA%\\Claude-Data\\claude_xxx.
  try {
    const cd = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
    for (const d of fs.readdirSync(cd)) dirs.push(path.join(cd, d));
  } catch { /* ancienne version de l'appli Claude */ }
  const entry = { command: process.execPath, args: [bridgeFile(), infoFile()], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const done = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const file = path.join(dir, 'claude_desktop_config.json');
      let cfg = {};
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file + '.terraforge.bak', text);
        cfg = text.trim() ? JSON.parse(text) : {};
      }
      if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
      cfg.mcpServers.terraforge = entry;
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      done.push(file);
    } catch (err) { console.error('MCP', err); }
  }
  if (!done.length) return say('warning', "L'appli Claude n'a pas été trouvée", "Installe et ouvre une fois l'appli Claude pour Windows, puis recommence.");
  say('info', 'TerraForge est branché à Claude', `Ferme complètement l'appli Claude (clic droit sur son icône près de l'horloge, Quitter), puis rouvre-la.\n\nFichier modifié :\n${done.join('\n')}`);
}

// Une seule fenêtre TerraForge à la fois : un second lancement ramène la première au premier plan.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); } });
  app.whenReady().then(() => { setupOverpass(); createWindow(); startControlServer(); });
}
app.on('window-all-closed', () => app.quit());
