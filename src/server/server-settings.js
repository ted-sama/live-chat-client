const { safeStorage } = require('electron');

const DEFAULT_SERVER_URL = 'https://live-chat.intrlude.app';
const STORE_KEYS = {
    url: 'server.url',
    encryptedApiKey: 'server.apiKey',
};

function normalizeServerUrl(value) {
    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        throw new Error('Adresse du serveur invalide.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('L’adresse du serveur doit commencer par https:// ou http://.');
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
}

function createServerSettings(store) {
    return {
        get url() {
            return store.get(STORE_KEYS.url, DEFAULT_SERVER_URL);
        },

        setUrl(value) {
            const url = normalizeServerUrl(value);
            store.set(STORE_KEYS.url, url);
            return url;
        },

        get hasApiKey() {
            return store.has(STORE_KEYS.encryptedApiKey);
        },

        get apiKey() {
            const encrypted = store.get(STORE_KEYS.encryptedApiKey, null);
            if (!encrypted) return null;
            try {
                return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
            } catch {
                return null;
            }
        },

        setApiKey(value) {
            const key = String(value).trim();
            if (!key) {
                store.delete(STORE_KEYS.encryptedApiKey);
                return;
            }
            if (!safeStorage.isEncryptionAvailable()) {
                throw new Error('Le chiffrement du système est indisponible : la clé ne peut pas être enregistrée de façon sûre.');
            }
            store.set(STORE_KEYS.encryptedApiKey, safeStorage.encryptString(key).toString('base64'));
        },
    };
}

module.exports = { createServerSettings, normalizeServerUrl, DEFAULT_SERVER_URL };
