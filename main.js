const { app, BrowserWindow, screen, Tray, Menu } = require('electron');

let win;
let tray;

app.whenReady().then(() => {

    // Crée un tray
    tray = new Tray(`${__dirname}/assets/icon.png`);

    // Crée un menu pour le tray
    const contextMenu = Menu.buildFromTemplate([
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


app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
