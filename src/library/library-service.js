const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { IndexStore } = require('./index-store');
const { EmbedderClient } = require('./embedder-client');
const { Indexer } = require('./indexer');
const { MODEL, STORE_KEYS } = require('./config');

const FILENAME_BOOST = 0.15;
const SEARCH_LIMIT = 40;

function normalizeForMatch(text) {
    return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function isSameOrInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class LibraryService extends EventEmitter {
    constructor({ settings, userDataDir }) {
        super();
        this.settings = settings;
        this.dirs = {
            models: path.join(userDataDir, 'models'),
            library: path.join(userDataDir, 'library'),
            thumbs: path.join(userDataDir, 'thumbs'),
        };
        this.store = null;
        this.embedder = null;
        this.indexer = null;
        this.status = 'off';
        this.download = null;
        this.error = null;
    }

    get enabled() {
        return this.settings.get(STORE_KEYS.enabled, false);
    }

    get paused() {
        return this.settings.get(STORE_KEYS.paused, false);
    }

    get folders() {
        return this.settings.get(STORE_KEYS.folders, []);
    }

    get state() {
        return {
            enabled: this.enabled,
            paused: this.paused,
            folders: this.folders,
            status: this.status,
            device: this.embedder?.device ?? null,
            download: this.download,
            error: this.error,
            ...(this.indexer ? this.indexer.progress : { indexed: 0, errors: 0, pending: 0, current: null }),
        };
    }

    setStatus(status, error = null) {
        this.status = status;
        this.error = error;
        this.emit('change', this.state);
    }

    async enable() {
        this.settings.set(STORE_KEYS.enabled, true);
        await this.start();
    }

    async start() {
        if (this.indexer || !this.enabled) return;

        this.store = new IndexStore(this.dirs.library, MODEL);
        await this.store.load();

        this.embedder = new EmbedderClient({ cacheDir: this.dirs.models, thumbsDir: this.dirs.thumbs });
        this.embedder.on('download-progress', (download) => {
            this.download = download;
            this.setStatus('downloading');
        });
        this.embedder.on('ready', () => {
            this.download = null;
            this.setStatus('ready');
            this.indexer?.run();
        });
        this.embedder.on('restart', () => this.setStatus('loading'));
        this.embedder.on('error', (error) => this.setStatus('error', error.message));

        this.indexer = new Indexer({
            store: this.store,
            embedder: this.embedder,
            thumbsDir: this.dirs.thumbs,
            paused: this.paused,
        });
        this.indexer.on('change', () => this.emit('change', this.state));
        this.indexer.on('error', (error) => this.setStatus('error', error.message));

        this.setStatus('loading');
        this.embedder.start();

        for (const folder of this.folders) {
            this.indexer.watch(folder);
            this.indexer.rescanFolder(folder).catch((error) => console.warn(`[library] scan failed: ${error.message}`));
        }
    }

    async stop() {
        if (!this.indexer) return;
        const { indexer, embedder } = this;
        this.indexer = null;
        this.embedder = null;
        this.store = null;
        await indexer.stop();
        embedder.stop();
        this.download = null;
        this.setStatus('off');
    }

    async disable() {
        this.settings.set(STORE_KEYS.enabled, false);
        await this.stop();
    }

    async pause() {
        this.settings.set(STORE_KEYS.paused, true);
        await this.indexer?.pause();
        this.emit('change', this.state);
    }

    resume() {
        this.settings.set(STORE_KEYS.paused, false);
        this.indexer?.resume();
        this.emit('change', this.state);
    }

    async addFolder(folder) {
        const folders = this.folders;
        if (folders.some((existing) => isSameOrInside(folder, existing))) return;

        const kept = folders.filter((existing) => !isSameOrInside(existing, folder));
        for (const nested of folders.filter((existing) => isSameOrInside(existing, folder))) this.indexer?.unwatch(nested);
        this.settings.set(STORE_KEYS.folders, [...kept, folder]);

        if (this.indexer) {
            this.indexer.watch(folder);
            await this.indexer.rescanFolder(folder);
        }
        this.emit('change', this.state);
    }

    async removeFolder(folder) {
        this.settings.set(STORE_KEYS.folders, this.folders.filter((existing) => existing !== folder));
        await this.indexer?.forgetFolder(folder);
        this.emit('change', this.state);
    }

    async deleteData() {
        await this.disable();
        await Promise.all(Object.values(this.dirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
        this.emit('change', this.state);
    }

    findEntry(id) {
        return this.store?.findById(id) ?? null;
    }

    thumbnailPath(entry) {
        return entry.thumb ? path.join(this.dirs.thumbs, entry.thumb) : null;
    }

    async search(query) {
        if (!this.store) return [];
        const entries = [...this.store.entries.values()].filter((entry) => this.store.vectors.has(entry.id));

        const text = query.trim();
        if (!text) {
            return entries
                .sort((a, b) => b.mtimeMs - a.mtimeMs)
                .slice(0, SEARCH_LIMIT)
                .map((entry) => ({ entry, score: null }));
        }

        const queryVector = await this.embedder.embedQuery(text);
        const tokens = normalizeForMatch(text).split(/\s+/).filter(Boolean);

        return entries
            .map((entry) => {
                const vector = this.store.vectors.get(entry.id);
                let score = 0;
                for (let i = 0; i < vector.length; i++) score += vector[i] * queryVector[i];
                const name = normalizeForMatch(path.basename(entry.path));
                if (tokens.every((token) => name.includes(token))) score += FILENAME_BOOST;
                return { entry, score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, SEARCH_LIMIT);
    }
}

module.exports = { LibraryService };
