const { app, BrowserWindow, screen, Tray, Menu, ipcMain } = require('electron');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const store = new Store();

let win;
let tray;
let selectedDisplayMode = store.get('displayMode', 'default');
let launchOnStartup = store.get('launchOnStartup', true);

app.whenReady().then(() => {

    // Lancement au démarrage de l'ordinateur
    // app.setLoginItemSettings({
    //     openAtLogin: true,
    //     openAsHidden: false
    // });

    // Crée un tray
    tray = new Tray(`${__dirname}/assets/icon.png`);

    // Crée un menu pour le tray
    const contextMenu = Menu.buildFromTemplate([
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
            label: "Lancer au démarrage",
            type: 'checkbox',
            checked: launchOnStartup,
            click: () => {
                launchOnStartup = !launchOnStartup;
                store.set('launchOnStartup', launchOnStartup);
                app.setLoginItemSettings({
                    openAtLogin: launchOnStartup,
                    openAsHidden: false
                });
            }
        },
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
    tray.setContextMenu(contextMenu);

    // Récupère les informations du premier écran
    const display = screen.getPrimaryDisplay();

    // Récupère la taille de l'écran
    const { width, height } = display.workAreaSize;

    win = new BrowserWindow({
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

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    win.setIgnoreMouseEvents(true, { forward: true }); // Permet de cliquer à travers la fenêtre
    // win.webContents.openDevTools()

    win.on('blur', () => {
        win.setAlwaysOnTop(true, "screen-saver");
        win.focus();
    });

    win.loadURL(`file://${__dirname}/index.html`);

    // Envoie le mode d'affichage à la fenêtre
    changeDisplayMode(selectedDisplayMode);

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

// Update events
autoUpdater.on('update-available', () => {
    win.webContents.send('update_available');
});

autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update_downloaded');
});

// Restart app and install update
ipcMain.on('restart_app', () => {
  autoUpdater.quitAndInstall();
});

// Close app
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
