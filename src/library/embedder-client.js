const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { utilityProcess } = require('electron');

const MAX_RESTARTS_PER_MINUTE = 3;
const REQUEST_TIMEOUT_MS = { init: 30 * 60_000, 'embed-file': 5 * 60_000, 'embed-query': 30_000 };

class EmbedderUnavailableError extends Error {}
class EmbedderCrashError extends Error {}

function unpackedPath(binaryPath) {
    // Native binaries cannot be executed from inside the asar archive; electron-builder unpacks them next to it.
    return binaryPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

class EmbedderClient extends EventEmitter {
    constructor({ cacheDir, thumbsDir }) {
        super();
        this.settings = {
            cacheDir,
            thumbsDir,
            ffmpegPath: unpackedPath(require('ffmpeg-static')),
            ffprobePath: unpackedPath(require('ffprobe-static').path),
        };
        this.child = null;
        this.pending = new Map();
        this.nextId = 1;
        this.stopping = false;
        this.restarts = [];
        this.ready = null;
        this.device = null;
    }

    start() {
        this.stopping = false;
        this.child = utilityProcess.fork(path.join(__dirname, 'embedder-process.js'), [], {
            serviceName: 'Live Chat Embedder',
            stdio: 'inherit',
        });

        try {
            os.setPriority(this.child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
            // Lowering priority is best effort; some platforms refuse it without privileges.
        }

        this.child.on('message', (message) => this.onMessage(message));
        this.child.on('exit', (code) => this.onExit(code));

        this.ready = this.send('init', { settings: this.settings }).then(
            ({ device }) => {
                this.device = device;
                this.emit('ready', device);
                return device;
            },
            (error) => {
                throw error instanceof EmbedderCrashError ? error : new EmbedderUnavailableError(error.message);
            },
        );
        this.ready.catch((error) => {
            if (!(error instanceof EmbedderCrashError)) this.emit('error', error);
        });
    }

    onMessage(message) {
        if (message.type === 'download-progress') {
            this.emit('download-progress', { loaded: message.loaded, total: message.total });
            return;
        }
        if (message.type !== 'reply') return;

        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.ok) request.resolve(message.result);
        else request.reject(new Error(message.error));
    }

    onExit(code) {
        this.child = null;
        this.device = null;
        for (const request of this.pending.values()) request.reject(new EmbedderCrashError(`embedder exited (code ${code})`));
        this.pending.clear();
        if (this.stopping) return;

        const now = Date.now();
        this.restarts = this.restarts.filter((time) => now - time < 60_000);
        if (this.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
            this.emit('error', new Error(`embedder crashed ${MAX_RESTARTS_PER_MINUTE} times in a minute`));
            return;
        }
        this.restarts.push(now);
        this.emit('restart', code);
        this.start();
    }

    send(type, payload = {}) {
        if (!this.child) return Promise.reject(new EmbedderUnavailableError('embedder is not running'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`embedder did not answer ${type} in time`));
            }, REQUEST_TIMEOUT_MS[type] ?? 60_000);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.child.postMessage({ ...payload, id, type });
        });
    }

    async waitUntilReady() {
        for (;;) {
            const current = this.ready;
            if (!current) throw new EmbedderUnavailableError('embedder is not running');
            try {
                return await current;
            } catch (error) {
                if (error instanceof EmbedderCrashError && this.ready !== current) continue;
                throw error instanceof EmbedderCrashError ? new EmbedderUnavailableError(error.message) : error;
            }
        }
    }

    async embedFile(filePath, id) {
        await this.waitUntilReady();
        return this.send('embed-file', { path: filePath, entryId: id });
    }

    async embedQuery(text) {
        await this.waitUntilReady();
        const { vector } = await this.send('embed-query', { text });
        return Float32Array.from(vector);
    }

    stop() {
        this.stopping = true;
        if (this.child) this.child.kill();
    }
}

module.exports = { EmbedderClient, EmbedderUnavailableError, EmbedderCrashError };
