const path = require('path');
const { dialog, shell } = require('electron');
const { buildLibraryMenu } = require('./tray-menu');
const { STORE_KEYS } = require('./config');

const MENU_REFRESH_MS = 500;

async function confirm({ message, detail, confirmLabel, destructive = false }) {
    const { response } = await dialog.showMessageBox({
        type: destructive ? 'warning' : 'question',
        buttons: [confirmLabel, 'Annuler'],
        defaultId: destructive ? 1 : 0,
        cancelId: 1,
        message,
        detail,
    });
    return response === 0;
}

async function pickFolder() {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Choisir un dossier de memes',
        properties: ['openDirectory'],
    });
    return canceled ? null : filePaths[0];
}

// The library service is required lazily so a user who never enables the feature loads none of it.
function createLibraryTray({ settings, userDataDir, onMenuChange, openLauncher, launcherShortcut }) {
    let service = null;
    let refreshTimer = null;

    const scheduleRefresh = () => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            onMenuChange();
        }, MENU_REFRESH_MS);
    };

    const getService = () => {
        if (!service) {
            const { LibraryService } = require('./library-service');
            service = new LibraryService({ settings, userDataDir });
            service.on('change', scheduleRefresh);
        }
        return service;
    };

    const guarded = (action) => async () => {
        try {
            await action();
        } catch (error) {
            dialog.showErrorBox('Recherche de memes', error.message);
        }
        onMenuChange();
    };

    const actions = {
        enable: guarded(async () => {
            const accepted = await confirm({
                message: 'Activer la recherche de memes ?',
                detail: [
                    'Un modèle d’IA d’environ 510 Mo sera téléchargé une seule fois.',
                    'Tes images et vidéos sont analysées en local, en arrière-plan : rien ne quitte ta machine.',
                    'L’indexation peut être mise en pause à tout moment depuis ce menu.',
                ].join('\n\n'),
                confirmLabel: 'Activer',
            });
            if (!accepted) return;

            const library = getService();
            if (library.folders.length === 0) {
                const folder = await pickFolder();
                if (folder) settings.set(STORE_KEYS.folders, [folder]);
            }
            await library.enable();
        }),
        disable: guarded(() => getService().disable()),
        pause: guarded(() => getService().pause()),
        resume: guarded(async () => getService().resume()),
        addFolder: guarded(async () => {
            const folder = await pickFolder();
            if (folder) await getService().addFolder(folder);
        }),
        removeFolder: (folder) => guarded(async () => {
            const accepted = await confirm({
                message: `Retirer « ${path.basename(folder)} » de la recherche ?`,
                detail: 'Les fichiers ne sont pas supprimés, ils sont seulement retirés de l’index.',
                confirmLabel: 'Retirer',
            });
            if (accepted) await getService().removeFolder(folder);
        })(),
        revealFolder: (folder) => shell.openPath(folder),
        openLauncher: () => openLauncher(),
        deleteData: guarded(async () => {
            const accepted = await confirm({
                message: 'Supprimer le modèle et l’index ?',
                detail: 'La recherche de memes sera désactivée. Tes fichiers ne sont pas touchés, mais il faudra retélécharger le modèle et tout réindexer pour la réactiver.',
                confirmLabel: 'Supprimer',
                destructive: true,
            });
            if (accepted) await getService().deleteData();
        }),
    };

    return {
        start() {
            if (settings.get(STORE_KEYS.enabled, false)) {
                getService().start().catch((error) => console.error('[library] start failed:', error));
            }
        },
        menuItem() {
            const state = service ? service.state : { enabled: false };
            return buildLibraryMenu(state, actions, launcherShortcut());
        },
        addFolder: actions.addFolder,
        shutdown() {
            return service ? service.stop() : Promise.resolve();
        },
        get service() {
            return service;
        },
    };
}

module.exports = { createLibraryTray };
