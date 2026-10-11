const fs = require('fs/promises');
const path = require('path');
const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, GIF_EXTENSION } = require('./config');

function extensionOf(filePath) {
    return path.extname(filePath).slice(1).toLowerCase();
}

function isEligible(filePath) {
    const extension = extensionOf(filePath);
    return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension) || extension === GIF_EXTENSION;
}

async function scanFolder(root) {
    const files = [];
    const pending = [root];

    while (pending.length > 0) {
        const dir = pending.pop();
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                pending.push(fullPath);
            } else if (entry.isFile() && isEligible(fullPath)) {
                try {
                    const { size, mtimeMs } = await fs.stat(fullPath);
                    files.push({ path: fullPath, size, mtimeMs });
                } catch {
                    // The file vanished between readdir and stat.
                }
            }
        }
    }

    return files;
}

module.exports = { scanFolder, extensionOf, isEligible };
