const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const { MODEL, VIDEO_FRAME_COUNT, THUMBNAIL_SIZE, GIF_EXTENSION, IMAGE_EXTENSIONS } = require('./config');

const run = promisify(execFile);

let settings = null;
let transformers = null;
let processor = null;
let model = null;
let device = null;

const queryQueue = [];
const fileQueue = [];
let busy = false;

function post(message) {
    process.parentPort.postMessage(message);
}

function createDownloadTracker() {
    const files = new Map();
    return (event) => {
        if (event.status !== 'progress' || !event.total) return;
        files.set(event.file, { loaded: event.loaded, total: event.total });
        let loaded = 0;
        let total = 0;
        for (const file of files.values()) {
            loaded += file.loaded;
            total += file.total;
        }
        post({ type: 'download-progress', loaded, total });
    };
}

async function loadOn(targetDevice, allowRemote) {
    const { env, AutoConfig, AutoModel, AutoProcessor } = transformers;
    env.allowRemoteModels = allowRemote;
    const progress_callback = createDownloadTracker();

    const config = await AutoConfig.from_pretrained(MODEL.id, { progress_callback });
    config.audio_config = null;
    const loadedProcessor = await AutoProcessor.from_pretrained(MODEL.id, { progress_callback });
    const loadedModel = await AutoModel.from_pretrained(MODEL.id, {
        config,
        device: targetDevice,
        dtype: { model: MODEL.dtype, vision_encoder: MODEL.dtype },
        progress_callback,
    });

    // A session can be created on a device that then fails at its first run, so warm up before trusting it.
    await loadedModel(await loadedProcessor(['task: search result | query: warmup']));
    return { loadedProcessor, loadedModel };
}

async function loadModel() {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = settings.cacheDir;

    let lastError = null;
    for (const candidate of MODEL.devices) {
        try {
            let loaded;
            try {
                loaded = await loadOn(candidate, false);
            } catch {
                loaded = await loadOn(candidate, true);
            }
            processor = loaded.loadedProcessor;
            model = loaded.loadedModel;
            device = candidate;
            return;
        } catch (error) {
            lastError = error;
            console.warn(`[embedder] device ${candidate} unavailable: ${error.message}`);
        }
    }
    throw lastError;
}

async function embed(...inputs) {
    const { sentence_embedding } = await model(await processor(...inputs));
    return Array.from(sentence_embedding.data);
}

async function writeThumbnail(source, id) {
    const target = path.join(settings.thumbsDir, `${id}.webp`);
    await sharp(source, { animated: false })
        .rotate()
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover' })
        .webp({ quality: 70 })
        .toFile(target);
    return path.basename(target);
}

async function probeDurationSeconds(filePath) {
    const { stdout } = await run(settings.ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
}

async function extractFrame(filePath, seconds, target) {
    const seek = seconds === null ? [] : ['-ss', seconds.toFixed(3)];
    await run(settings.ffmpegPath, [
        '-v', 'error', '-y',
        ...seek,
        '-i', filePath,
        '-frames:v', '1',
        '-vf', "scale='min(768,iw)':-2",
        target,
    ]);
    return target;
}

// Timestamps match RawVideo's uniform spacing for RawImage[] input: (i + 1) / (n + 1) * duration.
async function extractFrames(filePath, tmpDir) {
    const duration = await probeDurationSeconds(filePath);
    const timestamps = duration === null
        ? [null]
        : Array.from({ length: VIDEO_FRAME_COUNT }, (_, i) => ((i + 1) / (VIDEO_FRAME_COUNT + 1)) * duration);

    const targets = await Promise.all(
        timestamps.map((seconds, i) => extractFrame(filePath, seconds, path.join(tmpDir, `frame-${i}.jpg`)).catch(() => null)),
    );

    const framePaths = [];
    const frames = [];
    for (const target of targets) {
        if (!target) continue;
        try {
            frames.push(await transformers.RawImage.read(target));
            framePaths.push(target);
        } catch {
            // ffmpeg writes nothing when seeking past the last decodable frame of short clips.
        }
    }
    if (frames.length === 0) throw new Error('no decodable frame');
    return { frames, framePaths, durationSeconds: duration ?? 1 };
}

async function isAnimatedGif(filePath) {
    const { pages = 1 } = await sharp(filePath).metadata();
    return pages > 1;
}

async function embedVideo(filePath, id) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livechat-frames-'));
    try {
        const { frames, framePaths, durationSeconds } = await extractFrames(filePath, tmpDir);
        const vector = await embed(null, null, null, new transformers.RawVideo(frames, durationSeconds));
        const thumb = await writeThumbnail(framePaths[Math.floor(framePaths.length / 2)], id);
        return { vector, thumb, durationMs: Math.round(durationSeconds * 1000) };
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}

async function embedImage(filePath, id) {
    const vector = await embed(null, await transformers.RawImage.read(filePath));
    const thumb = await writeThumbnail(filePath, id);
    return { vector, thumb };
}

async function embedFile({ path: filePath, entryId: id }) {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const isGif = extension === GIF_EXTENSION;
    const asVideo = isGif ? await isAnimatedGif(filePath) : !IMAGE_EXTENSIONS.has(extension);

    const result = asVideo ? await embedVideo(filePath, id) : await embedImage(filePath, id);
    return { ...result, kind: asVideo && !isGif ? 'video' : 'image', animated: asVideo && isGif };
}

async function embedQuery({ text }) {
    return { vector: await embed([`task: search result | query: ${text}`]) };
}

async function handle(message) {
    switch (message.type) {
        case 'init':
            settings = message.settings;
            await fs.mkdir(settings.thumbsDir, { recursive: true });
            await loadModel();
            return { device };
        case 'embed-file':
            return embedFile(message);
        case 'embed-query':
            return embedQuery(message);
        default:
            throw new Error(`unknown message type: ${message.type}`);
    }
}

// Model calls are serialized because ONNX Runtime sessions are not safe to run concurrently on WebGPU;
// queries jump ahead of indexing work so search stays responsive during a long indexing pass.
async function drain() {
    if (busy) return;
    busy = true;
    while (queryQueue.length > 0 || fileQueue.length > 0) {
        const message = queryQueue.shift() ?? fileQueue.shift();
        try {
            post({ type: 'reply', id: message.id, ok: true, result: await handle(message) });
        } catch (error) {
            post({ type: 'reply', id: message.id, ok: false, error: error.message });
        }
    }
    busy = false;
}

process.parentPort.on('message', ({ data }) => {
    (data.type === 'embed-file' ? fileQueue : queryQueue).push(data);
    drain();
});
