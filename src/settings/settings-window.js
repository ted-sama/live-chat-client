const path = require('path');
const { BrowserWindow, ipcMain, safeStorage } = require('electron');
const { normalizeServerUrl } = require('../server/server-settings');

function createSettingsWindow({ serverSettings, sendService, onServerUrlChange }) {
    let window = null;

    function open() {
        if (window) {
            window.show();
            window.focus();
            return;
        }

        window = new BrowserWindow({
            width: 460,
            height: 330,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            title: 'Réglages du serveur',
            backgroundColor: '#00000000',
            ...(process.platform === 'darwin' ? { vibrancy: 'window' } : { backgroundMaterial: 'mica' }),
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                spellcheck: false,
            },
        });
        window.setMenuBarVisibility(false);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.once('ready-to-show', () => {
            window.show();
            window.focus();
        });
        window.on('closed', () => {
            window = null;
        });
        window.loadFile(path.join(__dirname, 'index.html'));
    }

    const fromSettings = (handler) => (event, ...args) => {
        if (!window || event.sender !== window.webContents) throw new Error('unexpected sender');
        return handler(...args);
    };

    ipcMain.handle('settings:get', fromSettings(() => ({
        url: serverSettings.url,
        hasApiKey: serverSettings.hasApiKey,
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
    })));

    ipcMain.handle('settings:test', fromSettings(async (url) => {
        let normalized;
        try {
            normalized = normalizeServerUrl(url);
        } catch (error) {
            return { ok: false, message: error.message };
        }
        return sendService.checkConnection(normalized);
    }));

    ipcMain.handle('settings:save', fromSettings(async ({ url, apiKey, removeApiKey }) => {
        try {
            const previousUrl = serverSettings.url;
            const savedUrl = serverSettings.setUrl(url);
            if (removeApiKey) serverSettings.setApiKey('');
            else if (String(apiKey ?? '').trim()) serverSettings.setApiKey(apiKey);
            if (savedUrl !== previousUrl) onServerUrlChange(savedUrl);
            window?.close();
            return { ok: true };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    }));

    ipcMain.handle('settings:close', fromSettings(() => window?.close()));

    return { open };
}

module.exports = { createSettingsWindow };
