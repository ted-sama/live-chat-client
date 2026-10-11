# Spec — Meme search launcher (local semantic search)

- **Status:** Draft
- **Date:** 2026-10-11
- **Scope:** `live-chat-client` (Electron). No change to `live-chat-back` or `live-chat-front`.

## 1. Goal

Find and send a meme (image or video) from a local folder in a few keystrokes, without a file picker.

The user presses a global shortcut and a Spotlight-style launcher opens. They type a description in any language, e.g. "chat qui tombe de la table". Results from the indexed folders are ranked by semantic similarity. `Enter` sends the selected file to the overlay pipeline that already exists.

Search runs fully on-device with **EmbeddingGemma 2**. No media leaves the machine except the file actually sent.

### Non-goals (v1)

- Audio files, PDFs, and other documents.
- Searching inside the web front (`live-chat-front` keeps its current flow).
- Generating text descriptions with a VLM. Search relies on the embedding's native cross-modal matching.
- Syncing the library or index across machines.
- Links and YouTube downloads (they stay in the web front).

## 2. Background

- The overlay is a single `BrowserWindow`: transparent, `focusable: false`, `setIgnoreMouseEvents(true, { forward: true })` (`main.js:148-170`). **It stays untouched.**
- The tray menu exists (`main.js:27`) and holds the display settings.
- The server URL is hardcoded in `renderer.js:6`. The client has no API key, because it only receives `play` events today.
- Sending today goes through `POST /api/upload/{image|video}-by-file`:
  - multipart fields `src`, `caption`, and `duration` (ms, `0` = full video length)
  - `x-api-key` header
  - 90 MB per-file cap by default (`UPLOAD_MAX_BYTES`)

## 3. Model and runtime (verified 2026-10-11)

| Item | Choice |
|---|---|
| Model | `onnx-community/embeddinggemma-2-ONNX` (EmbeddingGemma 2, Apache 2.0, released 2026-10-06) |
| Runtime | `@huggingface/transformers` **≥ 4.3.1**, which brought EmbeddingGemma 2 support; Node device `"cpu"` (onnxruntime-node) |
| Sub-models loaded | Text + vision only (`config.audio_config = null`) |
| dtype | **q8** (text 314 MB + vision 195 MB ≈ 509 MB). The first spike showed q4 is slower than q8 (2× on CPU, +17% on WebGPU) and ranks identically, so q4 is not an option. |
| Device | **WebGPU** through onnxruntime-node, falling back to `cpu` when unavailable. The first spike (M4) gave ~8.5 s/video on WebGPU vs ~14.7 s on CPU, and ~1 GB peak RSS vs ~2.9 GB. Still to validate: WebGPU inside an Electron `utilityProcess`, and on Windows (`webgpu` vs `dml`). |
| Dimension | 768 (native). Truncating to 256 costs about 5% on multimodal retrieval; not worth it at this library size. |
| Query prompt | `task: search result \| query: {text}` |
| Media input | Images: no prefix. Videos: `RawVideo(frames, durationSeconds)`, with frames as `RawImage[]` |
| Similarity | Output is normalized, so cosine = dot product |

Sources:
- https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
- https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/
- https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/

Model-side constraints that shape the design:

- **Video:** sampled at 1 fps by default, and uniformly subsampled above 32 frames. We extract **8 uniform frames** ourselves with ffmpeg. The 176-file spike scored the same with 8 frames as with 16 (92% vs 90% top-1, 100% recall@5) and ran 42% faster (7.5 s vs 12.9 s per video on WebGPU). That bounds cost and gives the same behavior for a 3 s clip and a 2 min one.
- **Context:** 8,192 tokens shared by all modalities. An image costs 280 soft tokens by default and a video frame 140, so 8 frames ≈ 1,120 tokens.

### Model delivery

The model is **not bundled** in the installer, which would add ~500 MB. It downloads from the Hugging Face Hub only once the user turns the feature on (§5, "Opt-in"):

- Cache: `app.getPath('userData')/models` (transformers.js `env.cacheDir`).
- The tray (and later the launcher) shows download progress. Search is disabled until the download finishes.
- After download, `env.allowRemoteModels = false`, so the app works offline.

## 4. Architecture

```
┌──────────────── main process ────────────────┐
│ tray · globalShortcut · window mgmt          │
│ LibraryService (scan, watch, index store)    │
│ SendService (multipart POST to back)         │
│ protocol handler  livechat-media://          │
└───────┬──────────────────────┬───────────────┘
        │ IPC (preload bridge) │ MessagePort
┌───────▼────────┐    ┌────────▼─────────────────┐
│ Launcher window │    │ utilityProcess: embedder │
│ (sandboxed UI)  │    │ transformers.js + ORT    │
└─────────────────┘    │ ffmpeg frame extraction  │
                       └──────────────────────────┘
┌─────────────────┐
│ Overlay window  │  unchanged
└─────────────────┘
```

- **Embedder in an Electron `utilityProcess`.** Inference is CPU-heavy and must never block the main process: the tray, shortcut and overlay must stay responsive while thousands of files index. A crash in the embedder restarts it and never kills the overlay.
- **Embedder interface.** It is the only module that knows about EmbeddingGemma, so the engine can be swapped later, e.g. for a cloud provider:
  ```ts
  interface Embedder {
    readonly modelId: string;   // stored in the index manifest
    readonly dim: number;
    embedQuery(text: string): Promise<Float32Array>;
    embedImage(path: string): Promise<Float32Array>;
    embedVideo(path: string): Promise<Float32Array>;
  }
  ```
- **Launcher window** is sandboxed (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). It reaches the main process only through a `preload.js` bridge (§7).

## 5. Library indexing

### Opt-in

The whole feature is **off by default**. A user who never turns it on gets today's app: no model download, no utility process, no folder scan, no extra CPU or memory. The library modules are not even `require`d.

- Setting `library.enabled` (electron-store), default `false`.
- Turning it on, from the tray entry "Recherche de memes → Activer…", opens a confirmation dialog. It states that:
  - about 510 MB will be downloaded;
  - indexing runs locally in the background and can be paused;
  - nothing leaves the machine.
- Confirming saves the setting, then asks for a first folder if none is set, then starts the model download and indexing.
- Turning it off stops the utility process and the watchers immediately. The model and index stay on disk, so turning it back on resumes without re-indexing.
- A separate "Supprimer le modèle et l'index…" entry (with confirmation) deletes `userData/models`, `userData/library` and `userData/thumbs`.

### Folders

- The user adds or removes folders from the launcher settings or the tray. Folders go through the native `dialog.showOpenDialog({ properties: ['openDirectory'] })`; this dialog appears only when adding a folder, never when sending.
- The folder list persists in `electron-store` (`library.folders: string[]`).
- Scans are recursive. Hidden files and folders (leading `.`) are skipped.

### Eligible files

The extensions match the back allowlist:

| Kind | Extensions |
|---|---|
| image | jpg, jpeg, png, webp, avif, bmp |
| video | mp4, webm, mov, m4v, mkv, **gif** |

Animated GIFs index as video (frames) and send as images, since the back serves them as `image`. Static GIFs (1 frame) index as images.

Files over `UPLOAD_MAX_BYTES` (90 MB, mirrored in client config) still index, but show as "too large" and cannot be sent.

### Pipeline

1. **Scan.** Walk the folders and build `{ path, size, mtimeMs }`.
2. **Diff.** Compare with the manifest, keyed by absolute path.
   - New file, or changed `size` or `mtimeMs` → embed.
   - Missing file → drop the entry.
3. **Embed** in the utilityProcess, one file at a time:
   - Image: load through transformers.js `RawImage` (sharp).
   - Video/GIF: run ffprobe for duration, then use ffmpeg to extract 8 frames uniformly spaced over the duration (fewer if the video is shorter than 8 frames). Build a `RawVideo`.
   - Unreadable or corrupt file: record `error` in the manifest and skip it. It is retried on the next change only.
4. **Thumbnail** generated during the same pass:
   - Image: sharp resize to 160 px.
   - Video: the middle frame among those extracted.
   - Stored in `userData/thumbs/<sha1(path)>.webp`.
5. **Persist** every 25 files and at the end of the pass, so an interrupted index resumes where it stopped.

### Background behavior

- A full scan and diff runs at startup and when a folder is added.
- `fs.watch(folder, { recursive: true })` watches each folder (supported on macOS and Windows). Events are debounced 1 s, then trigger a diff of the affected paths.
- Indexing runs at low priority: one file at a time, yielding between files. Search works on whatever part of the index is ready.
- The tray, and later the launcher, shows "Indexation : 312 / 1 840" while work is pending.

### Pause

The user can pause indexing at any time, e.g. during a game or on battery:

- The tray toggles between "Mettre en pause l'indexation" and "Reprendre l'indexation".
- Pause is cooperative. The main process stops handing files to the embedder, the file in progress finishes (≤ ~10 s), and the index is saved right away.
- While paused:
  - Watchers keep running, so new files are queued but not embedded.
  - Search still works on what is already indexed.
  - The model stays loaded, so queries stay fast. Only the indexing loop is idle.
- The paused state persists (`library.paused`), so a paused index does not silently start again after a restart.

### Index storage

The index lives in `userData/library/`, with no native DB dependency:

- `manifest.json`: `{ version, modelId, dtype, dim, entries: [{ id, path, kind, size, mtimeMs, durationMs?, thumb, vecOffset, error? }] }`
- `vectors.bin`: contiguous `Float32Array`, `dim` floats per entry, addressed by `vecOffset`.

Both files are written atomically (write to `.tmp`, then rename).

If `modelId`, `dtype` or `dim` differs from the running embedder, the index is discarded and rebuilt. Vectors from different models are not comparable.

Size: 768 × 4 B = 3 KB per entry, so 10,000 memes take 30 MB, loaded fully in memory.

## 6. Search

1. The query is debounced 120 ms, then embedded with the search-query prefix.
2. Brute-force dot product against every vector in memory. At 10k × 768 this is a few milliseconds and needs no ANN index.
3. **Filename boost:** if every query token appears in the file name (case- and accent-insensitive), add a fixed bonus of `+0.15`. This keeps exact recall for files the user named on purpose, e.g. `ah-denis-la-menace.mp4`.
4. Return the top 40, grouped as **Vidéos** and **Images**, as in the reference UI. Ordering is by score within each group, and groups are ordered by their best score.
5. **Empty query** shows the 40 most recently modified files, so the launcher is useful before typing.

There is no score threshold in v1. Results are always ranked, never hidden.

## 7. Launcher window

### Window

- Frameless and rounded, 760 × 480, `resizable: false`.
- Opens centered on the display under the cursor.
- `alwaysOnTop` at level `"screen-saver"` keeps it above the overlay (`"pop-up-menu"`).
- `visibleOnAllWorkspaces`. Hidden from the macOS dock and app switcher (`skipTaskbar: true`).
- Created once and then shown or hidden, never destroyed, so it opens instantly.
- It hides when:
  - `Esc` is pressed,
  - the window loses focus (`blur`),
  - or a send succeeds.

### Opening it

- Global shortcut, default `CommandOrControl+Shift+Space`, configurable in settings.
  - If `globalShortcut.register` fails because the combination is taken, show a tray notification.
- Tray menu gains two entries: "Rechercher un média…" and "Bibliothèque…" (folders and settings).

### Layout

The layout follows the screenshot reference:

- **Left column:** the search field (autofocus), then the grouped result list. Each row shows thumbnail, file name, parent folder, and a duration badge for videos.
- **Right column:** a preview.
  - Image: shown full size.
  - Video: autoplays muted on loop.
  - Under the preview: name, size, date, and duration.
  - Then the send form:
    - caption (optional)
    - duration presets 3 s / 5 s / 10 s / 30 s / Complète (same as `MediaSender.vue:161-167`)
    - **Envoyer** button
- **Footer:** result count, indexing progress, and shortcut hints.

### Keyboard

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Send with current caption and duration |
| `Tab` | Focus caption field; `Enter` from caption also sends |
| `⌘/Ctrl + 1…5` | Pick duration preset |
| `⌘/Ctrl + Enter` | Reveal in Finder / Explorer |
| `Esc` | Clear query, or hide the window if the query is empty |

Default duration is 5 s for images and "Complète" for videos, the same defaults as the back.

### Media access from the renderer

Thumbnails and previews load through a custom protocol, `livechat-media://<entryId>/thumb` and `livechat-media://<entryId>/file`, registered with `protocol.handle`.

The handler resolves only ids present in the manifest. The renderer never sees or requests arbitrary file paths, and `file://` stays blocked by CSP.

### Preload bridge

The bridge is the whole renderer API:

```ts
window.liveChat = {
  search(query: string): Promise<SearchResult[]>;
  send(entryId: string, opts: { caption: string; durationMs: number }): Promise<void>;
  revealInFolder(entryId: string): void;
  getLibraryState(): Promise<{ folders: string[]; indexed: number; total: number; modelReady: boolean }>;
  addFolder(): Promise<void>;
  removeFolder(path: string): Promise<void>;
  onStateChange(cb: (state) => void): () => void;
  hide(): void;
};
```

## 8. Sending

`SendService` runs in the main process:

1. Look up the entry and check that the file still exists and is ≤ the size cap.
2. `fs.openAsBlob(path)` → `FormData` with `src` (with the original file name), `caption`, and `duration` in ms.
3. `POST ${serverUrl}/api/upload/${kind}-by-file` with `x-api-key`. `kind` is `image` or `video`; GIF is always `image`.
4. Success: hide the launcher and record the entry as "recently sent" (used in the v2 ranking).
5. Failure: keep the launcher open with an inline error. A 413 shows "Fichier trop lourd", and a 401 points to settings.

### Client configuration (new)

- `serverUrl` replaces the hardcoded URL in `renderer.js:6`. The overlay also reads it from the store.
- `apiKey` is set in the launcher settings and stored with `safeStorage.encryptString` (Keychain / DPAPI), never in plain text in `electron-store`.

## 9. Packaging

- New dependencies: `@huggingface/transformers@^4.3.1`, `ffmpeg-static`, `ffprobe-static`. sharp moves from devDependencies to dependencies; transformers.js already requires it in Node.
- electron-builder:
  - `asarUnpack` for `onnxruntime-node`, `sharp`, `ffmpeg-static`, and `ffprobe-static` (native binaries cannot run from inside asar).
  - `files` gains `launcher/**`, `src/**`, and `preload.js`.
- Expected installer growth is about 80–100 MB (ORT + ffmpeg); the model is excluded (§3). To be measured during the spike.
- Native modules must match the Electron ABI (`electron-builder install-app-deps`).

## 10. Delivery plan

| Phase | Content | Exit criterion |
|---|---|---|
| **0 — Spike** | Standalone script in a utilityProcess: load q8 and q4, embed 50 real memes (images and videos) plus 15 queries in French and English. | Measure per-image and per-video latency on the dev Mac and a Windows machine, and recall@5 for each dtype. Go/no-go and dtype decided here. |
| **1 — Library core** | Folder config, scan/diff/watch, embedder process, manifest + vectors store, thumbnails. | Index survives restart and resumes after a kill. |
| **2 — Launcher UI** | Window, shortcut, tray entries, search, preview, keyboard nav, custom protocol. | Search to selected result in under 300 ms on a 2k-file library. |
| **3 — Send + config** | SendService, server URL/API key settings with safeStorage, overlay reads `serverUrl` from store. | End-to-end send shows on another client. |
| **4 — Packaging** | asarUnpack, signed macOS/Windows builds, first-run model download UX. | Clean install on a machine without dev tooling. |

## 11. Risks

| Risk | Mitigation |
|---|---|
| EmbeddingGemma 2 support in transformers.js is days old (4.3.1). Node/CPU multimodal paths may have bugs. | Phase 0 spike before any UI work. Fallback engine behind `Embedder`: Ollama is listed as a supported runtime, but its multimodal support for this model is unverified. |
| CPU indexing of videos is slow on low-end machines. | Fixed 8 frames, one file at a time, resumable index, search on a partial index. Measured on M4 + WebGPU: ~1.4 s per image, ~7.5 s per video. |
| Text overlaid on memes (captions, impact font) is only partly captured by the vision encoder. | Filename boost in v1. v2 adds a user-editable note per entry, embedded as a document and max-pooled with the media score. |
| `fs.watch` misses events on network drives. | Full rescan when the launcher opens if the last scan is older than 10 min. |
| Shortcut conflicts (Spotlight/Raycast often use Space combos). | Configurable shortcut; registration failure is surfaced. |

## 12. Open questions

1. Should the launcher also allow sending a file dragged into it from Finder, like the web dropzone? Proposed: yes, low cost, phase 2.
2. Should "Récemment envoyés" be a section shown on an empty query? Proposed: v2.
