// Application de bureau : une simple fenêtre qui affiche l'éditeur (dist-single/index.html).
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 650,
    backgroundColor: '#070b14',
    title: 'TerraForge',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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

app.whenReady().then(() => { setupOverpass(); createWindow(); });
app.on('window-all-closed', () => app.quit());
