const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_VERSION = 1;

function entryIdFor(filePath) {
    return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

function isInside(filePath, folder) {
    const relative = path.relative(folder, filePath);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function writeAtomically(target, data) {
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, target);
}

class IndexStore {
    constructor(dir, model) {
        this.dir = dir;
        this.model = model;
        this.manifestPath = path.join(dir, 'manifest.json');
        this.entries = new Map();
        this.vectors = new Map();
        this.dirty = false;
        this.saving = Promise.resolve();
    }

    async load() {
        await fs.mkdir(this.dir, { recursive: true });
        let manifest;
        try {
            manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
        } catch {
            return;
        }

        const compatible = manifest.version === MANIFEST_VERSION
            && manifest.modelId === this.model.id
            && manifest.dtype === this.model.dtype
            && manifest.dim === this.model.dim;
        if (!compatible) {
            this.dirty = true;
            return;
        }

        this.vectorsFile = manifest.vectorsFile;
        let buffer = null;
        try {
            buffer = await fs.readFile(path.join(this.dir, manifest.vectorsFile));
        } catch {
            // Entries without vectors get re-embedded on the next scan.
        }
        const allVectors = buffer
            ? new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
            : new Float32Array(0);

        for (const { vecIndex, ...entry } of manifest.entries) {
            const start = vecIndex * this.model.dim;
            const hasVector = vecIndex >= 0 && start + this.model.dim <= allVectors.length;
            if (vecIndex >= 0 && !hasVector) continue;
            this.entries.set(entry.path, entry);
            if (hasVector) this.vectors.set(entry.id, allVectors.slice(start, start + this.model.dim));
        }
    }

    get(filePath) {
        return this.entries.get(filePath);
    }

    upsert(entry, vector) {
        this.entries.set(entry.path, entry);
        if (vector) this.vectors.set(entry.id, vector);
        else this.vectors.delete(entry.id);
        this.dirty = true;
    }

    remove(filePath) {
        const entry = this.entries.get(filePath);
        if (!entry) return null;
        this.entries.delete(filePath);
        this.vectors.delete(entry.id);
        this.dirty = true;
        return entry;
    }

    findById(id) {
        for (const entry of this.entries.values()) if (entry.id === id) return entry;
        return null;
    }

    pathsUnder(folder) {
        return [...this.entries.keys()].filter((filePath) => isInside(filePath, folder));
    }

    get size() {
        return this.entries.size;
    }

    get vectorCount() {
        return this.vectors.size;
    }

    save() {
        this.saving = this.saving.then(() => this.writeToDisk()).catch((error) => {
            this.dirty = true;
            console.error('[library] failed to save index:', error);
        });
        return this.saving;
    }

    async writeToDisk() {
        if (!this.dirty) return;
        this.dirty = false;

        const { dim } = this.model;
        const entries = [...this.entries.values()];
        const vectorBuffer = new Float32Array(this.vectors.size * dim);
        let nextIndex = 0;

        const manifestEntries = entries.map((entry) => {
            const vector = this.vectors.get(entry.id);
            if (!vector) return { ...entry, vecIndex: -1 };
            vectorBuffer.set(vector, nextIndex * dim);
            return { ...entry, vecIndex: nextIndex++ };
        });

        // The manifest rename is the commit point: it names a fresh vectors file, so a crash
        // between the two writes can never pair a manifest with another generation's vectors.
        const vectorsFile = `vectors-${Date.now()}.bin`;
        const manifest = {
            version: MANIFEST_VERSION,
            vectorsFile,
            modelId: this.model.id,
            dtype: this.model.dtype,
            dim,
            entries: manifestEntries,
        };

        await fs.mkdir(this.dir, { recursive: true });
        await writeAtomically(path.join(this.dir, vectorsFile), Buffer.from(vectorBuffer.buffer, 0, nextIndex * dim * 4));
        await writeAtomically(this.manifestPath, JSON.stringify(manifest));

        const previous = this.vectorsFile;
        this.vectorsFile = vectorsFile;
        if (previous && previous !== vectorsFile) await fs.rm(path.join(this.dir, previous), { force: true });
    }
}

module.exports = { IndexStore, entryIdFor };
