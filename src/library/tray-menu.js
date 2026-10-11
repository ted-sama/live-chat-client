const path = require('path');

const numberFormat = new Intl.NumberFormat('fr-FR');

function formatMegabytes(bytes) {
    return numberFormat.format(Math.round(bytes / 1024 / 1024));
}

function describeStatus(state) {
    if (state.status === 'error') return `Erreur : ${state.error}`;
    if (state.status === 'downloading' && state.download) {
        const { loaded, total } = state.download;
        return `Téléchargement du modèle : ${Math.floor((loaded / total) * 100)} % (${formatMegabytes(loaded)} / ${formatMegabytes(total)} Mo)`;
    }
    if (state.status === 'loading') return 'Chargement du modèle…';
    if (state.folders.length === 0) return 'Aucun dossier ajouté';

    const total = state.indexed + state.pending;
    if (state.pending > 0) {
        const progress = `${numberFormat.format(state.indexed)} / ${numberFormat.format(total)}`;
        return state.paused ? `En pause : ${progress}` : `Indexation : ${progress}`;
    }
    return `À jour : ${numberFormat.format(state.indexed)} médias`;
}

function buildLibraryMenu(state, actions, launcherShortcut) {
    if (!state.enabled) {
        return {
            label: 'Recherche de memes',
            submenu: [
                { label: 'Activer…', click: actions.enable },
                { type: 'separator' },
                { label: 'Supprimer le modèle et l’index…', click: actions.deleteData },
            ],
        };
    }

    const folderItems = state.folders.map((folder) => ({
        label: path.basename(folder) || folder,
        submenu: [
            { label: folder, enabled: false },
            { label: process.platform === 'darwin' ? 'Afficher dans le Finder' : 'Afficher dans l’Explorateur', click: () => actions.revealFolder(folder) },
            { label: 'Retirer', click: () => actions.removeFolder(folder) },
        ],
    }));

    const errorsNote = state.errors > 0 ? [{ label: `${numberFormat.format(state.errors)} fichier(s) illisible(s)`, enabled: false }] : [];
    const deviceNote = state.device ? [{ label: `Calcul : ${state.device === 'webgpu' ? 'GPU' : 'CPU'}`, enabled: false }] : [];

    return {
        label: 'Recherche de memes',
        submenu: [
            { label: 'Rechercher un média…', accelerator: launcherShortcut, registerAccelerator: false, click: actions.openLauncher },
            { type: 'separator' },
            { label: describeStatus(state), enabled: false },
            ...errorsNote,
            ...deviceNote,
            { type: 'separator' },
            state.paused
                ? { label: 'Reprendre l’indexation', click: actions.resume }
                : { label: 'Mettre en pause l’indexation', click: actions.pause },
            { type: 'separator' },
            { label: 'Ajouter un dossier…', click: actions.addFolder },
            ...(folderItems.length ? [{ label: 'Dossiers', submenu: folderItems }] : []),
            { type: 'separator' },
            { label: 'Désactiver', click: actions.disable },
            { label: 'Supprimer le modèle et l’index…', click: actions.deleteData },
        ],
    };
}

module.exports = { buildLibraryMenu };
