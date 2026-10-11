const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, globalShortcut, ipcMain, net, protocol, screen, shell, systemPreferences } = require('electron');
const { MAX_UPLOAD_BYTES } = require('../library/config');

const MEDIA_SCHEME = 'livechat-media';
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';
const SHORTCUT_STORE_KEY = 'library.shortcut';
const WINDOW_SIZE = { width: 760, height: 480 };

// Must run before app 'ready': privileged schemes cannot be registered afterwards.
function registerMediaScheme() {
    protocol.registerSchemesAsPrivileged([
        { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    ]);
}

function systemAccentColor() {
    try {
        const rgba = systemPreferences.getAccentColor();
        return rgba ? `#${rgba.slice(0, 6)}` : null;
    } catch {
        return null;
    }
}

function containingFolder(filePath, folders) {
    return folders.find((folder) => !path.relative(folder, filePath).startsWith('..')) ?? path.dirname(filePath);
}

function toResult({ entry, score }, folders) {
    const root = containingFolder(entry.path, folders);
    const relativeDir = path.relative(root, path.dirname(entry.path));
    return {
        id: entry.id,
        name: path.basename(entry.path),
        folder: relativeDir ? path.join(path.basename(root), relativeDir) : path.basename(root),
        kind: entry.kind,
        animated: Boolean(entry.animated),
        durationMs: entry.durationMs ?? null,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        score,
        tooLarge: entry.size > MAX_UPLOAD_BYTES,
        thumbUrl: `${MEDIA_SCHEME}://thumb/${entry.id}`,
        fileUrl: `${MEDIA_SCHEME}://file/${entry.id}`,
    };
}

function createLauncher({ settings, getLibrary, addFolder, send, openSettings }) {
    let window = null;
    let registeredShortcut = null;

    const shortcut = () => settings.get(SHORTCUT_STORE_KEY, DEFAULT_SHORTCUT);

    function launcherState() {
        const library = getLibrary();
        const state = library?.state ?? { enabled: false };
        return {
            enabled: state.enabled,
            status: state.status ?? 'off',
            download: state.download ?? null,
            error: state.error ?? null,
            paused: Boolean(state.paused),
            indexed: state.indexed ?? 0,
            pending: state.pending ?? 0,
            folders: state.folders?.length ?? 0,
            device: state.device ?? null,
            accentColor: systemAccentColor(),
            shortcut: shortcut(),
        };
    }

    function createWindow() {
        const isMac = process.platform === 'darwin';
        window = new BrowserWindow({
            ...WINDOW_SIZE,
            show: false,
            frame: false,
            resizable: false,
            movable: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            hiddenInMissionControl: true,
            alwaysOnTop: true,
            transparent: isMac,
            backgroundColor: '#00000000',
            ...(isMac ? { vibrancy: 'hud', visualEffectState: 'active' } : { backgroundMaterial: 'acrylic' }),
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                spellcheck: false,
            },
        });

        // Above the overlay, which sits at the "pop-up-menu" level.
        window.setAlwaysOnTop(true, 'screen-saver');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.on('blur', () => hide());
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.loadFile(path.join(__dirname, 'index.html'));
    }

    function show() {
        if (!getLibrary()?.state.enabled) return;
        if (!window) createWindow();

        const cursor = screen.getCursorScreenPoint();
        const { workArea } = screen.getDisplayNearestPoint(cursor);
        window.setBounds({
            x: Math.round(workArea.x + (workArea.width - WINDOW_SIZE.width) / 2),
            y: Math.round(workArea.y + workArea.height * 0.22),
            ...WINDOW_SIZE,
        });

        const reveal = () => {
            window.show();
            window.focus();
            window.webContents.send('launcher:shown', launcherState());
        };
        if (window.webContents.isLoading()) window.webContents.once('did-finish-load', reveal);
        else reveal();
    }

    function hide() {
        if (window?.isVisible()) window.hide();
    }

    function toggle() {
        if (window?.isVisible()) hide();
        else show();
    }

    function syncShortcut(enabled) {
        const wanted = enabled ? shortcut() : null;
        if (wanted === registeredShortcut) return true;
        if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
        registeredShortcut = null;
        if (!wanted) {
            hide();
            return true;
        }
        const ok = globalShortcut.register(wanted, toggle);
        if (ok) registeredShortcut = wanted;
        else console.warn(`[launcher] shortcut ${wanted} is already taken`);
        return ok;
    }

    function notifyStateChange() {
        if (window?.isVisible()) window.webContents.send('launcher:state-changed', launcherState());
    }

    const fromLauncher = (handler) => (event, ...args) => {
        if (!window || event.sender !== window.webContents) throw new Error('unexpected sender');
        return handler(...args);
    };

    ipcMain.handle('launcher:state', fromLauncher(() => launcherState()));
    ipcMain.handle('launcher:search', fromLauncher(async (query) => {
        const library = getLibrary();
        if (!library) return [];
        const results = await library.search(String(query ?? ''));
        return results.map((result) => toResult(result, library.folders));
    }));
    ipcMain.handle('launcher:send', fromLauncher(async (id, options) => {
        const entry = getLibrary()?.findEntry(String(id));
        if (!entry) return { ok: false, message: 'Ce fichier n’est plus dans la bibliothèque.' };
        try {
            await send(entry, {
                caption: String(options?.caption ?? '').slice(0, 500),
                durationMs: Math.max(0, Number(options?.durationMs) || 0),
            });
        } catch (error) {
            return { ok: false, message: error.message, action: error.action ?? null };
        }
        hide();
        return { ok: true };
    }));
    ipcMain.handle('launcher:open-settings', fromLauncher(() => {
        hide();
        openSettings();
    }));
    ipcMain.handle('launcher:reveal', fromLauncher((id) => {
        const entry = getLibrary()?.findEntry(String(id));
        if (entry) shell.showItemInFolder(entry.path);
    }));
    ipcMain.handle('launcher:add-folder', fromLauncher(async () => {
        hide();
        await addFolder();
    }));
    ipcMain.handle('launcher:hide', fromLauncher(() => hide()));

    protocol.handle(MEDIA_SCHEME, (request) => {
        const { host, pathname } = new URL(request.url);
        const library = getLibrary();
        const entry = library?.findEntry(pathname.slice(1));
        const target = !entry ? null : host === 'thumb' ? library.thumbnailPath(entry) : host === 'file' ? entry.path : null;
        if (!target) return new Response(null, { status: 404 });
        return net.fetch(pathToFileURL(target).toString(), { headers: request.headers });
    });

    return {
        show,
        hide,
        toggle,
        syncShortcut,
        notifyStateChange,
        get shortcut() {
            return shortcut();
        },
        dispose() {
            if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
            registeredShortcut = null;
        },
    };
}

module.exports = { createLauncher, registerMediaScheme };
