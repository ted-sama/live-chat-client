const MODEL = {
    id: 'onnx-community/embeddinggemma-2-ONNX',
    dtype: 'q8',
    dim: 768,
    devices: ['webgpu', 'cpu'],
};

const VIDEO_FRAME_COUNT = 8;
const THUMBNAIL_SIZE = 160;
const SAVE_EVERY_N_FILES = 25;
const WATCH_DEBOUNCE_MS = 1000;
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);
const GIF_EXTENSION = 'gif';

const STORE_KEYS = {
    enabled: 'library.enabled',
    paused: 'library.paused',
    folders: 'library.folders',
};

module.exports = {
    MODEL,
    VIDEO_FRAME_COUNT,
    THUMBNAIL_SIZE,
    SAVE_EVERY_N_FILES,
    WATCH_DEBOUNCE_MS,
    MAX_UPLOAD_BYTES,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    GIF_EXTENSION,
    STORE_KEYS,
};
