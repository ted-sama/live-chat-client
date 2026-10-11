const { app, BrowserWindow, screen, Tray, Menu, ipcMain } = require('electron');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const { createLibraryTray } = require('./src/library/library-tray');
const { createLauncher, registerMediaScheme } = require('./src/launcher/launcher');
const { createServerSettings } = require('./src/server/server-settings');
const { createSendService } = require('./src/server/send-service');
const { createSettingsWindow } = require('./src/settings/settings-window');

const store = new Store();

let win;
let tray;
const serverSettings = createServerSettings(store);
let selectedDisplayMode = store.get('displayMode', 'default');
let launchOnStartup = store.get('launchOnStartup', true);
let selectedScreenId = store.get('selectedScreen', null);
let selectedScreenBounds = store.get('selectedScreenBounds', null);
let isMuted = store.get('muted', false);
let libraryTray;
let launcher;
let isQuitting = false;

registerMediaScheme();

// Une seule instance : une 2e instance (ex: autolaunch + lancement manuel)
// écraserait les réglages du store
if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}

function applyLoginItemSettings() {
    app.setLoginItemSettings({
        openAtLogin: launchOnStartup,
        openAsHidden: false,
        path: process.execPath
    });
}

// Les display.id ne sont pas stables entre redémarrages sur Windows :
// on matche par id puis par bounds sauvegardés
function findSavedDisplay() {
    const displays = screen.getAllDisplays();
    let d = displays.find(d => d.id === selectedScreenId);
    if (!d && selectedScreenBounds) {
        d = displays.find(d =>
            d.bounds.x === selectedScreenBounds.x &&
            d.bounds.y === selectedScreenBounds.y &&
            d.bounds.width === selectedScreenBounds.width &&
            d.bounds.height === selectedScreenBounds.height
        );
    }
    return d || screen.getPrimaryDisplay();
}

function saveSelectedScreen(display) {
    selectedScreenId = display.id;
    selectedScreenBounds = display.bounds;
    store.set('selectedScreen', selectedScreenId);
    store.set('selectedScreenBounds', selectedScreenBounds);
}

function assertAlwaysOnTop() {
    if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(true, 'screen-saver');
    }
}

app.whenReady().then(() => {

    // Apply saved autolaunch setting at startup
    applyLoginItemSettings();

    // Create tray with platform-specific icon
    // macOS uses template images that adapt to light/dark mode
    const trayIcon = process.platform === 'darwin'
        ? `${__dirname}/assets/iconTemplate.png`
        : `${__dirname}/assets/icon.png`;
    tray = new Tray(trayIcon);

    // Build screen selection submenu
    const buildScreenSubmenu = () => {
        const displays = screen.getAllDisplays();
        const savedDisplay = findSavedDisplay();
        return displays.map((display, index) => ({
            label: `Écran ${index + 1} (${display.bounds.width}x${display.bounds.height})`,
            type: 'radio',
            checked: display.id === savedDisplay.id,
            click: () => {
                saveSelectedScreen(display);
                moveWindowToScreen(display);
            }
        }));
    };

    libraryTray = createLibraryTray({
        settings: store,
        userDataDir: app.getPath('userData'),
        onMenuChange: () => refreshTrayMenu(),
        openLauncher: () => launcher.show(),
        launcherShortcut: () => launcher.shortcut,
    });

    const sendService = createSendService(serverSettings);
    const settingsWindow = createSettingsWindow({
        serverSettings,
        sendService,
        onServerUrlChange: () => win?.reload(),
    });

    launcher = createLauncher({
        settings: store,
        getLibrary: () => libraryTray.service,
        addFolder: () => libraryTray.addFolder(),
        send: sendService.send,
        openSettings: settingsWindow.open,
    });

    // Crée un menu pour le tray
    const buildContextMenu = () => Menu.buildFromTemplate([
        // Screen selection
        {
            label: "Écran",
            submenu: buildScreenSubmenu()
        },
        // modes d'affichage (par défaut (milieu de l'ecran), coin haut gauche, coin haut droit, coin bas gauche, coin bas droit) modifie le css de l'image et de la caption
        {
            label: "Affichage",
            submenu: [
                {
                    label: "Par défaut",
                    type: 'radio',
                    checked: selectedDisplayMode === 'default',
                    click: () => {
                        selectedDisplayMode = 'default';
                        changeDisplayMode(selectedDisplayMode);
                    }
                },
                {
                    label: "Haut gauche",
                    type: 'radio',
                    checked: selectedDisplayMode === 'top-left',
                    click: () => {
                        selectedDisplayMode = 'top-left';
                        changeDisplayMode(selectedDisplayMode);
                    }
                },
                {
                    label: "Haut droit",
                    type: 'radio',
                    checked: selectedDisplayMode === 'top-right',
                    click: () => {
                        selectedDisplayMode = 'top-right';
                        changeDisplayMode(selectedDisplayMode);
                    }
                },
                {
                    label: "Bas gauche",
                    type: 'radio',
                    checked: selectedDisplayMode === 'bottom-left',
                    click: () => {
                        selectedDisplayMode = 'bottom-left';
                        changeDisplayMode(selectedDisplayMode);
                    }
                },
                {
                    label: "Bas droit",
                    type: 'radio',
                    checked: selectedDisplayMode === 'bottom-right',
                    click: () => {
                        selectedDisplayMode = 'bottom-right';
                        changeDisplayMode(selectedDisplayMode);
                    }
                }
            ]
        },
        {
            label: "Muet",
            type: 'checkbox',
            checked: isMuted,
            click: () => {
                isMuted = !isMuted;
                store.set('muted', isMuted);
                if (win) {
                    win.webContents.send('set-muted', isMuted);
                }
            }
        },
        {
            label: "Lancer au démarrage",
            type: 'checkbox',
            checked: launchOnStartup,
            click: () => {
                launchOnStartup = !launchOnStartup;
                store.set('launchOnStartup', launchOnStartup);
                applyLoginItemSettings();
            }
        },
        libraryTray.menuItem(),
        { label: 'Réglages du serveur…', click: () => settingsWindow.open() },
        { type: 'separator' },
        {
            label: 'Quitter',
            click: () => {
                app.quit();
            }
        }
    ]);

    // Associe le menu au tray
    tray.setToolTip('Live Chat');
    const refreshTrayMenu = () => {
        tray.setContextMenu(buildContextMenu());
        launcher.syncShortcut(Boolean(libraryTray.service?.state.enabled));
        launcher.notifyStateChange();
    };
    refreshTrayMenu();
    libraryTray.start();

    // Get the selected display or primary
    let display = findSavedDisplay();

    // Get screen size
    const { width, height } = display.workAreaSize;
    const { x, y } = display.bounds;

    win = new BrowserWindow({
        x: x,
        y: y,
        width: width,
        height: height,
        alwaysOnTop: true, // Garde la fenêtre au premier plan
        transparent: true, // Optionnel, pour avoir un fond transparent
        frame: false, // Sans bordure
        resizable: false, // Ne peut pas être redimensioné par l'utilisateur
        focusable: false, // Ne prend pas le focus
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true }); // Permet de cliquer à travers la fenêtre
    // win.webContents.openDevTools()

    // Windows peut retirer le flag always-on-top (apps plein écran,
    // redémarrage d'explorer...) : on le ré-applique périodiquement
    win.on('blur', assertAlwaysOnTop);
    setInterval(assertAlwaysOnTop, 3000);

    win.loadURL(`file://${__dirname}/index.html`);

    // Envoie le mode d'affichage à la fenêtre
    changeDisplayMode(selectedDisplayMode);

    // Send initial muted state
    win.webContents.on('did-finish-load', () => {
        win.webContents.send('set-muted', isMuted);
    });

    // Auto updates
    if (!app.isPackaged) {
        console.log("Mode developpement : les mises a jour automatiques sont desactivees.");
    } else {
        autoUpdater.checkForUpdatesAndNotify();
    }
});

function changeDisplayMode(mode) {
    if (win) {
        store.set('displayMode', mode);
        win.webContents.send('update-position', mode);
    }
}

function moveWindowToScreen(display) {
    if (win) {
        const { width, height } = display.workAreaSize;
        const { x, y } = display.bounds;
        win.setBounds({ x, y, width, height });
    }
}

// Update events
autoUpdater.on('update-available', () => {
    win.webContents.send('update_available');
});

autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update_downloaded');
});

// The overlay renderer connects its socket at load time, before any async round trip.
ipcMain.on('server:get-url', (event) => {
    event.returnValue = serverSettings.url;
});

// Restart app and install update
ipcMain.on('restart_app', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

// Saves the meme search index before quitting; bounded so a stuck embedder never blocks the exit.
app.on('before-quit', (event) => {
    if (isQuitting || !libraryTray?.service) return;
    event.preventDefault();
    isQuitting = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([libraryTray.shutdown(), timeout])
        .catch((error) => console.error('[library] shutdown failed:', error))
        .finally(() => app.quit());
});

app.on('will-quit', () => launcher?.dispose());

// Close app
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
