// Application de bureau : une simple fenêtre qui affiche l'éditeur (dist-single/index.html).
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 650,
    backgroundColor: '#14171c',
    title: 'TerraForge',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  // Écran de démarrage : le logo, le temps que l'éditeur se charge.
  const splash = new BrowserWindow({ width: 720, height: 480, frame: false, resizable: false, center: true, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#0b0c0e', icon: path.join(__dirname, '..', 'build', 'icon.png') });
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
