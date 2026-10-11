const fs = require('fs/promises');
const path = require('path');
const { net } = require('electron');
const { MAX_UPLOAD_BYTES } = require('../library/config');

const MIME_TYPES = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    mkv: 'video/x-matroska',
};
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

class SendError extends Error {
    constructor(message, action = null) {
        super(message);
        this.action = action;
    }
}

async function readServerError(response) {
    try {
        const body = await response.json();
        return typeof body?.error === 'string' ? body.error : null;
    } catch {
        return null;
    }
}

function createSendService(serverSettings) {
    function headers() {
        const apiKey = serverSettings.apiKey;
        return apiKey ? { 'x-api-key': apiKey } : {};
    }

    async function send(entry, { caption, durationMs }) {
        let stats;
        try {
            stats = await fs.stat(entry.path);
        } catch {
            throw new SendError('Ce fichier a été déplacé ou supprimé.');
        }
        if (stats.size > MAX_UPLOAD_BYTES) throw new SendError('Fichier trop lourd pour être envoyé (90 Mo max).');

        const extension = path.extname(entry.path).slice(1).toLowerCase();
        const route = entry.kind === 'video' ? 'video-by-file' : 'image-by-file';
        const form = new FormData();
        form.append('src', new Blob([await fs.readFile(entry.path)], { type: MIME_TYPES[extension] }), path.basename(entry.path));
        form.append('caption', caption);
        form.append('duration', String(durationMs));

        let response;
        try {
            response = await net.fetch(`${serverSettings.url}/api/upload/${route}`, {
                method: 'POST',
                headers: headers(),
                body: form,
                signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error.name === 'TimeoutError' ? 'délai dépassé' : 'serveur injoignable';
            throw new SendError(`Envoi impossible (${reason}).`, 'settings');
        }

        if (response.ok) return;
        const serverMessage = await readServerError(response);
        if (response.status === 401) throw new SendError('Clé API refusée par le serveur.', 'settings');
        if (response.status === 413) throw new SendError('Fichier trop lourd pour le serveur.');
        if (response.status === 415) throw new SendError('Format refusé par le serveur.');
        throw new SendError(`Erreur du serveur (${response.status}${serverMessage ? ` : ${serverMessage}` : ''}).`);
    }

    async function checkConnection(url = serverSettings.url) {
        try {
            const response = await net.fetch(`${url}/health`, {
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) return { ok: false, message: `Le serveur répond avec une erreur (${response.status}).` };
            const health = await response.json().catch(() => ({}));
            const queue = Number.isFinite(health.queue) ? ` · ${health.queue} en file d’attente` : '';
            return { ok: true, message: `Serveur joignable${queue}.` };
        } catch (error) {
            return { ok: false, message: error.name === 'TimeoutError' ? 'Le serveur ne répond pas (délai dépassé).' : 'Serveur injoignable.' };
        }
    }

    return { send, checkConnection };
}

module.exports = { createSendService, SendError };
