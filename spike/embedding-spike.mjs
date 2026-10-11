import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { AutoConfig, AutoModel, AutoProcessor, RawImage, RawVideo } from "@huggingface/transformers";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const run = promisify(execFile);

const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif", "bmp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "mkv", "gif"]);
const TOP_K = 5;

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    queries: { type: "string", default: "queries.json" },
    dtypes: { type: "string", default: "q8,q4" },
    frames: { type: "string", default: "8" },
    budget: { type: "string", default: "280" },
    limit: { type: "string", default: "50" },
    out: { type: "string", default: "out" },
    device: { type: "string", default: "cpu" },
  },
});

if (!args.dir) {
  console.error("Usage: node embedding-spike.mjs --dir <memes folder> [--queries queries.json] [--dtypes q8,q4] [--frames 16] [--budget 280] [--limit 50] [--out out]");
  process.exit(1);
}

const frameCount = Number(args.frames);
const imageBudget = Number(args.budget);
const limit = Number(args.limit);
const dtypes = args.dtypes.split(",").map((d) => d.trim());

const extensionOf = (file) => path.extname(file).slice(1).toLowerCase();

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (IMAGE_EXTENSIONS.has(extensionOf(full)) || VIDEO_EXTENSIONS.has(extensionOf(full))) files.push(full);
  }
  return files;
}

function pickSample(files) {
  const sorted = [...files].sort();
  const images = sorted.filter((f) => IMAGE_EXTENSIONS.has(extensionOf(f)));
  const videos = sorted.filter((f) => VIDEO_EXTENSIONS.has(extensionOf(f)));
  const half = Math.floor(limit / 2);
  const pickedVideos = videos.slice(0, Math.max(half, limit - images.length));
  const pickedImages = images.slice(0, limit - pickedVideos.length);
  return [...pickedImages, ...pickedVideos];
}

async function probeDuration(file) {
  const { stdout } = await run(ffprobeStatic.path, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

// Timestamps match RawVideo's uniform spacing for RawImage[] input: (i + 1) / (n + 1) * duration.
async function extractFrames(file, tmpDir) {
  const duration = await probeDuration(file);
  if (!duration) {
    const target = path.join(tmpDir, "frame-0.jpg");
    await run(ffmpegPath, ["-v", "error", "-y", "-i", file, "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", target]);
    return { frames: [await RawImage.read(target)], duration: 1 };
  }

  const timestamps = Array.from({ length: frameCount }, (_, i) => ((i + 1) / (frameCount + 1)) * duration);
  const targets = await Promise.all(
    timestamps.map(async (t, i) => {
      const target = path.join(tmpDir, `frame-${i}.jpg`);
      await run(ffmpegPath, [
        "-v", "error", "-y",
        "-ss", t.toFixed(3),
        "-i", file,
        "-frames:v", "1",
        "-vf", "scale='min(768,iw)':-2",
        target,
      ]);
      return target;
    }),
  );

  const frames = [];
  for (const target of targets) {
    try {
      frames.push(await RawImage.read(target));
    } catch {
      // ffmpeg writes nothing when seeking past the last decodable frame of short clips.
    }
  }
  if (frames.length === 0) throw new Error("no decodable frame");
  return { frames, duration };
}

async function loadModel(dtype) {
  const config = await AutoConfig.from_pretrained(MODEL_ID);
  config.audio_config = null;
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  processor.image_processor.max_soft_tokens = imageBudget;
  const model = await AutoModel.from_pretrained(MODEL_ID, {
    config,
    device: args.device,
    dtype: { model: dtype, vision_encoder: dtype },
  });
  return { processor, model };
}

const toVector = (tensor) => Float32Array.from(tensor.data);

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const stats = (values) => ({
  count: values.length,
  meanMs: values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null,
  p50Ms: percentile(values, 50) && Math.round(percentile(values, 50)),
  p95Ms: percentile(values, 95) && Math.round(percentile(values, 95)),
});

async function benchmarkDtype(dtype, files, queries, rootDir) {
  console.log(`\n=== ${dtype} ===`);
  let peakRss = process.memoryUsage().rss;
  const trackMemory = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));

  const loadStart = performance.now();
  const { processor, model } = await loadModel(dtype);
  const loadMs = Math.round(performance.now() - loadStart);
  trackMemory();
  console.log(`model loaded in ${loadMs} ms`);

  const embed = async (...inputs) => toVector((await model(await processor(...inputs))).sentence_embedding);

  const cachePath = path.join(args.out, `cache-${dtype}-${args.device}-f${frameCount}-b${imageBudget}.json`);
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8").catch(() => "{}"));
  const items = [];
  const timings = { imageEmbed: [], videoDecode: [], videoEmbed: [], query: [] };

  for (const [index, file] of files.entries()) {
    const relative = path.relative(rootDir, file);
    const isVideo = VIDEO_EXTENSIONS.has(extensionOf(file));
    const { size, mtimeMs } = await fs.stat(file);
    const cacheKey = `${relative}|${size}|${mtimeMs}`;
    if (cache[cacheKey]) {
      items.push({ file, relative, kind: isVideo ? "video" : "image", vector: Float32Array.from(cache[cacheKey]) });
      continue;
    }
    try {
      if (isVideo) {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spike-frames-"));
        try {
          const decodeStart = performance.now();
          const { frames, duration } = await extractFrames(file, tmpDir);
          const decodeMs = performance.now() - decodeStart;
          const embedStart = performance.now();
          const vector = await embed(null, null, null, new RawVideo(frames, duration));
          const embedMs = performance.now() - embedStart;
          timings.videoDecode.push(decodeMs);
          timings.videoEmbed.push(embedMs);
          items.push({ file, relative, kind: "video", vector, frames: frames.length });
          console.log(`[${index + 1}/${files.length}] video ${relative} — ${frames.length} frames, decode ${Math.round(decodeMs)} ms, embed ${Math.round(embedMs)} ms`);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      } else {
        const image = await RawImage.read(file);
        const embedStart = performance.now();
        const vector = await embed(null, image);
        const embedMs = performance.now() - embedStart;
        timings.imageEmbed.push(embedMs);
        items.push({ file, relative, kind: "image", vector });
        console.log(`[${index + 1}/${files.length}] image ${relative} — embed ${Math.round(embedMs)} ms`);
      }
    } catch (error) {
      console.warn(`[${index + 1}/${files.length}] SKIP ${relative}: ${error.message}`);
    }
    if (items.at(-1)?.file === file) cache[cacheKey] = Array.from(items.at(-1).vector);
    trackMemory();
  }
  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache));

  for (const item of items) {
    const stem = path.basename(item.relative, path.extname(item.relative)).replace(/[-_]+/g, " ");
    item.nameVector = await embed([`title: none | text: ${stem}`]);
  }

  const variantScores = {
    media: (m) => m,
    filename: (_, n) => n,
    hybridMax: (m, n) => Math.max(m, n),
    hybridMean: (m, n) => (m + n) / 2,
  };
  const variantHits = Object.fromEntries(Object.keys(variantScores).map((k) => [k, []]));

  const results = [];
  for (const { q, expect = [] } of queries) {
    const start = performance.now();
    const queryVector = await embed([`task: search result | query: ${q}`]);
    timings.query.push(performance.now() - start);

    const expected = new Set(expect.map((e) => e.toLowerCase()));
    const isHit = (r) => expected.has(path.basename(r.relative).toLowerCase()) || expected.has(r.relative.toLowerCase());

    const scored = items.map((item) => ({ item, media: dot(queryVector, item.vector), name: dot(queryVector, item.nameVector) }));
    if (expected.size) {
      for (const [variant, combine] of Object.entries(variantScores)) {
        const order = scored.map((x) => ({ relative: x.item.relative, score: combine(x.media, x.name) })).sort((a, b) => b.score - a.score);
        variantHits[variant].push(order.findIndex(isHit));
      }
    }

    const ranked = scored
      .map(({ item, media }) => ({ relative: item.relative, file: item.file, kind: item.kind, score: media }))
      .sort((a, b) => b.score - a.score);
    const firstHit = expected.size ? ranked.findIndex(isHit) : -1;

    results.push({
      query: q,
      expect,
      top: ranked.slice(0, TOP_K).map((r) => ({ ...r, hit: expected.size > 0 && isHit(r) })),
      hitAt5: expected.size ? firstHit >= 0 && firstHit < TOP_K : null,
      reciprocalRank: expected.size ? (firstHit >= 0 ? 1 / (firstHit + 1) : 0) : null,
    });
  }
  trackMemory();

  const judged = results.filter((r) => r.hitAt5 !== null);
  const summary = {
    dtype,
    loadMs,
    peakRssMb: Math.round(peakRss / 1024 / 1024),
    indexed: items.length,
    skipped: files.length - items.length,
    imageEmbed: stats(timings.imageEmbed),
    videoDecode: stats(timings.videoDecode),
    videoEmbed: stats(timings.videoEmbed),
    query: stats(timings.query),
    recallAt5: judged.length ? judged.filter((r) => r.hitAt5).length / judged.length : null,
    mrr: judged.length ? judged.reduce((s, r) => s + r.reciprocalRank, 0) / judged.length : null,
    judgedQueries: judged.length,
    variants: Object.fromEntries(
      Object.entries(variantHits).map(([variant, ranks]) => [
        variant,
        {
          top1: ranks.filter((r) => r === 0).length / ranks.length,
          recallAt5: ranks.filter((r) => r >= 0 && r < TOP_K).length / ranks.length,
          mrr: ranks.reduce((sum, r) => sum + (r >= 0 ? 1 / (r + 1) : 0), 0) / ranks.length,
        },
      ]),
    ),
  };

  await model.dispose?.();
  return { summary, results };
}

function overlapAt5(a, b) {
  return a.results.map((ra, i) => {
    const setA = new Set(ra.top.map((t) => t.relative));
    return b.results[i].top.filter((t) => setA.has(t.relative)).length / Math.max(1, setA.size);
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function renderReport(runs, env) {
  const media = (t) => {
    const src = pathToFileURL(t.file).href;
    return t.kind === "video" && extensionOf(t.file) !== "gif"
      ? `<video src="${src}" muted loop autoplay playsinline preload="metadata"></video>`
      : `<img src="${src}" loading="lazy">`;
  };

  const summaryRows = runs
    .map(({ summary: s }) => `<tr><td>${s.dtype}</td><td>${s.loadMs}</td><td>${s.imageEmbed.p50Ms ?? "–"} / ${s.imageEmbed.p95Ms ?? "–"}</td><td>${s.videoDecode.p50Ms ?? "–"} / ${s.videoDecode.p95Ms ?? "–"}</td><td>${s.videoEmbed.p50Ms ?? "–"} / ${s.videoEmbed.p95Ms ?? "–"}</td><td>${s.query.p50Ms ?? "–"}</td><td>${s.peakRssMb}</td><td>${s.recallAt5 === null ? "–" : (s.recallAt5 * 100).toFixed(0) + " %"}</td><td>${s.mrr === null ? "–" : s.mrr.toFixed(2)}</td></tr>`)
    .join("");

  const queries = runs[0].results
    .map((_, qi) => {
      const columns = runs
        .map(({ summary, results }) => {
          const r = results[qi];
          const cells = r.top
            .map((t, rank) => `<figure class="${t.hit ? "hit" : ""}">${media(t)}<figcaption><b>#${rank + 1}</b> ${t.score.toFixed(3)}<br>${escapeHtml(t.relative)}</figcaption></figure>`)
            .join("");
          return `<div class="col"><h4>${summary.dtype}</h4><div class="row">${cells}</div></div>`;
        })
        .join("");
      const expect = runs[0].results[qi].expect;
      return `<section><h3>${escapeHtml(runs[0].results[qi].query)}</h3>${expect.length ? `<p class="expect">attendu : ${expect.map(escapeHtml).join(", ")}</p>` : ""}${columns}</section>`;
    })
    .join("");

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>EmbeddingGemma 2 spike</title><style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#111;color:#eee}
table{border-collapse:collapse;margin-bottom:32px}td,th{border:1px solid #333;padding:6px 10px;text-align:right}th:first-child,td:first-child{text-align:left}
section{margin-bottom:40px}h3{margin:0 0 4px}.expect{color:#9a9;margin:0 0 8px}h4{margin:8px 0 4px;color:#aaa}
.row{display:flex;gap:8px}figure{margin:0;width:160px;padding:4px;border:2px solid transparent;border-radius:6px}figure.hit{border-color:#3c3}
img,video{width:100%;height:110px;object-fit:cover;border-radius:4px;background:#222}figcaption{font-size:11px;word-break:break-all;color:#bbb}
</style></head><body>
<h1>EmbeddingGemma 2 — spike</h1>
<p>${escapeHtml(env)}</p>
<table><tr><th>dtype</th><th>load ms</th><th>image p50/p95 ms</th><th>video decode p50/p95 ms</th><th>video embed p50/p95 ms</th><th>query p50 ms</th><th>peak RSS MB</th><th>recall@5</th><th>MRR</th></tr>${summaryRows}</table>
${queries}
</body></html>`;
}

async function main() {
  const rootDir = path.resolve(args.dir);
  const queries = JSON.parse(await fs.readFile(args.queries, "utf8"));
  const files = pickSample(await walk(rootDir));
  if (files.length === 0) throw new Error(`no eligible media in ${rootDir}`);

  const env = `${os.platform()} ${os.arch()} · ${os.cpus()[0]?.model ?? "unknown CPU"} · ${os.cpus().length} cores · ${Math.round(os.totalmem() / 1024 ** 3)} GB RAM · Node ${process.version} · device ${args.device} · ${files.length} files · ${frameCount} frames/video · image budget ${imageBudget}`;
  console.log(env);

  const runs = [];
  for (const dtype of dtypes) runs.push(await benchmarkDtype(dtype, files, queries, rootDir));

  const comparison = runs.length >= 2 ? { [`${runs[0].summary.dtype}_vs_${runs[1].summary.dtype}_overlapAt5`]: overlapAt5(runs[0], runs[1]) } : {};

  await fs.mkdir(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(args.out, `spike-${stamp}.json`);
  const htmlPath = path.join(args.out, `spike-${stamp}.html`);
  await fs.writeFile(jsonPath, JSON.stringify({ env, runs: runs.map(({ summary, results }) => ({ summary, results: results.map(({ top, ...r }) => ({ ...r, top: top.map(({ file, ...t }) => t) })) })), comparison }, null, 2));
  await fs.writeFile(htmlPath, renderReport(runs, env));

  console.log("\n" + JSON.stringify(runs.map((r) => r.summary), null, 2));
  if (Object.keys(comparison).length) {
    const [[name, overlaps]] = Object.entries(comparison);
    console.log(`${name}: mean ${(overlaps.reduce((s, v) => s + v, 0) / overlaps.length).toFixed(2)}`);
  }
  console.log(`\nreport: ${path.resolve(htmlPath)}\njson:   ${path.resolve(jsonPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
