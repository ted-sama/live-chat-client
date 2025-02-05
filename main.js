const { app, BrowserWindow, screen, Tray, Menu, ipcMain } = require('electron');

let win;
let tray;
let selectedDisplayMode = 'default';

app.whenReady().then(() => {

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

    win.setIgnoreMouseEvents(true); // Permet de cliquer à travers la fenêtre
    // win.webContents.openDevTools()
    win.loadURL(`file://${__dirname}/index.html`);
});

function changeDisplayMode(mode) {
    if (win) {
        win.webContents.send('update-position', mode);
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
