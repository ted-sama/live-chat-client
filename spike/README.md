# EmbeddingGemma 2 spike

Phase 0 of [the meme search spec](../docs/specs/2026-10-11-meme-search-launcher.md). This standalone Node script decides two things:

- whether EmbeddingGemma 2 runs well enough on CPU through transformers.js;
- which dtype (q8 or q4) to ship.

## Prerequisites

- Node 20+
- About 800 MB of free disk space. On the first run the model weights download into `node_modules/@huggingface/transformers/.cache`: text and vision encoders, q8 and q4.

## Setup

Install on the machine where you run the spike, because `ffmpeg-static` downloads a platform-specific binary:

```bash
npm install
cp queries.example.json queries.json
```

Edit `queries.json`. Each entry is a search query, plus optionally the file names that count as a correct answer:

```json
{ "q": "un chat qui tombe", "expect": ["cat-fail.mp4", "chat_table.gif"] }
```

`expect` matches either the file name or the path relative to `--dir`. Queries with an empty `expect` still appear in the report, but are left out of recall@5 and MRR. To fill `expect` easily, run once without it, look at the report, then add the files you would have wanted.

## Run

```bash
node embedding-spike.mjs --dir "D:\Memes"
```

| Option | Default | Meaning |
|---|---|---|
| `--dir` | required | Folder scanned recursively |
| `--queries` | `queries.json` | Query file |
| `--dtypes` | `q8,q4` | Comma-separated list, benchmarked in order |
| `--frames` | `8` | Frames sampled uniformly per video or GIF |
| `--budget` | `280` | Image soft-token budget (70, 140, 280, 560, 1120) |
| `--limit` | `50` | Files sampled, half images and half videos when possible |
| `--out` | `out` | Output folder |
| `--device` | `cpu` | ONNX Runtime device: `cpu`, `webgpu`, `coreml` (macOS), `dml` (Windows) |

## Output

The run writes two files to `out/`:

- `spike-<timestamp>.html`: a report to open in a browser. It shows:
  - a summary table: load time, p50/p95 latency for image embedding, video decoding and video embedding, query latency, peak RSS, recall@5 and MRR;
  - the top 5 results of each query for each dtype, side by side, with expected hits outlined in green.
- `spike-<timestamp>.json`: the same data as the report, without absolute paths. Send this one back for analysis.

The console also prints how far the q8 and q4 top-5 results overlap.

## Decision grid

| Signal | Go | Rethink |
|---|---|---|
| Image embed p50 | < 1.5 s | > 4 s: indexing 2k memes takes hours |
| Video embed p50 (16 frames) | < 8 s | > 20 s: try `--frames 8` |
| Query p50 | < 150 ms | > 400 ms: launcher feels laggy |
| recall@5 | ≥ 70 % | < 50 %: the v2 notes or VLM descriptions become mandatory |
| q8 vs q4 overlap@5 | ≥ 0.8 → ship q4 | lower → ship q8 |
