const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { scanFolder } = require('./scanner');
const { entryIdFor } = require('./index-store');
const { EmbedderUnavailableError } = require('./embedder-client');
const { SAVE_EVERY_N_FILES, WATCH_DEBOUNCE_MS } = require('./config');

class Indexer extends EventEmitter {
    constructor({ store, embedder, thumbsDir, paused }) {
        super();
        this.store = store;
        this.embedder = embedder;
        this.thumbsDir = thumbsDir;
        this.paused = paused;
        this.stopped = false;
        this.queue = new Map();
        this.current = null;
        this.running = false;
        this.embeddedSinceSave = 0;
        this.watchers = new Map();
        this.rescanTimers = new Map();
    }

    get progress() {
        let errors = 0;
        for (const entry of this.store.entries.values()) if (entry.error) errors++;
        return {
            indexed: this.store.vectorCount,
            errors,
            pending: this.queue.size + (this.current ? 1 : 0),
            current: this.current,
        };
    }

    async rescanFolder(folder) {
        const files = await scanFolder(folder);
        if (this.stopped) return;

        const seen = new Set();
        for (const file of files) {
            seen.add(file.path);
            const entry = this.store.get(file.path);
            const unchanged = entry && entry.size === file.size && entry.mtimeMs === file.mtimeMs;
            if (unchanged) this.queue.delete(file.path);
            else this.queue.set(file.path, file);
        }

        for (const filePath of this.store.pathsUnder(folder)) {
            if (!seen.has(filePath)) this.forget(filePath);
        }
        for (const filePath of this.queue.keys()) {
            if (filePath.startsWith(folder + path.sep) && !seen.has(filePath)) this.queue.delete(filePath);
        }

        this.emit('change');
        this.run();
    }

    forget(filePath) {
        this.queue.delete(filePath);
        const entry = this.store.remove(filePath);
        if (entry?.thumb) fs.rm(path.join(this.thumbsDir, entry.thumb), { force: true }, () => {});
    }

    forgetFolder(folder) {
        this.unwatch(folder);
        for (const filePath of this.store.pathsUnder(folder)) this.forget(filePath);
        for (const filePath of this.queue.keys()) {
            if (filePath.startsWith(folder + path.sep)) this.queue.delete(filePath);
        }
        this.emit('change');
        return this.store.save();
    }

    watch(folder) {
        if (this.watchers.has(folder)) return;
        try {
            const watcher = fs.watch(folder, { recursive: true }, () => this.scheduleRescan(folder));
            watcher.on('error', () => this.unwatch(folder));
            this.watchers.set(folder, watcher);
        } catch (error) {
            console.warn(`[library] cannot watch ${folder}: ${error.message}`);
        }
    }

    unwatch(folder) {
        this.watchers.get(folder)?.close();
        this.watchers.delete(folder);
        clearTimeout(this.rescanTimers.get(folder));
        this.rescanTimers.delete(folder);
    }

    scheduleRescan(folder) {
        clearTimeout(this.rescanTimers.get(folder));
        this.rescanTimers.set(folder, setTimeout(() => {
            this.rescanTimers.delete(folder);
            this.rescanFolder(folder).catch((error) => console.warn(`[library] rescan failed: ${error.message}`));
        }, WATCH_DEBOUNCE_MS));
    }

    pause() {
        this.paused = true;
        this.emit('change');
        return this.store.save();
    }

    resume() {
        this.paused = false;
        this.emit('change');
        this.run();
    }

    async stop() {
        this.stopped = true;
        for (const folder of [...this.watchers.keys()]) this.unwatch(folder);
        await this.store.save();
    }

    async run() {
        if (this.running) return;
        this.running = true;
        try {
            while (!this.paused && !this.stopped && this.queue.size > 0) {
                const [filePath, file] = this.queue.entries().next().value;
                this.queue.delete(filePath);
                this.current = filePath;
                this.emit('change');

                const keepGoing = await this.indexFile(filePath, file);
                this.current = null;
                if (!keepGoing) break;

                if (++this.embeddedSinceSave >= SAVE_EVERY_N_FILES) {
                    this.embeddedSinceSave = 0;
                    await this.store.save();
                }
                this.emit('change');
                await new Promise((resolve) => setImmediate(resolve));
            }
        } finally {
            this.running = false;
            this.current = null;
            await this.store.save();
            this.emit('change');
        }
    }

    async indexFile(filePath, file) {
        let stats;
        try {
            stats = await fs.promises.stat(filePath);
        } catch {
            this.forget(filePath);
            return true;
        }

        const base = { id: entryIdFor(filePath), path: filePath, size: stats.size, mtimeMs: stats.mtimeMs };
        try {
            const { vector, kind, animated, thumb, durationMs } = await this.embedder.embedFile(filePath, base.id);
            this.store.upsert({ ...base, kind, animated, thumb, durationMs }, Float32Array.from(vector));
        } catch (error) {
            if (this.stopped) {
                this.queue.set(filePath, file);
                return false;
            }
            if (error instanceof EmbedderUnavailableError) {
                // The embedder itself is down: put the file back and stop instead of blaming every file.
                this.queue.set(filePath, file);
                this.emit('error', error);
                return false;
            }
            this.store.upsert({ ...base, error: error.message }, null);
        }
        return true;
    }
}

module.exports = { Indexer };
