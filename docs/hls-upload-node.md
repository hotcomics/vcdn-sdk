# HLS directory upload (Node)

The `@vcdn/node` package exposes **`VcdnClient`** (`import { VcdnClient } from "@vcdn/node"`), separate from **`VcdnNodeClient`**, for uploading a **local HLS pack** (one media `.m3u8` and referenced `.ts` segments) to the upload-service public API.

`VcdnNodeClient` covers multipart file upload, video listing, and playback tokens. Use **`VcdnClient`** when you already have an HLS output directory on disk.

## Requirements

- **Node.js** `>=18`
- **API key** with access to the upload origin (sent as `X-API-Key`).
- **`baseUrl` / `baseURL`**: origin only, e.g. `https://upload.example.com` — do **not** append `/api/v1`.
- **ffmpeg** `>=4.4` (optional) — required only when `normalize` is `'auto'` (with issues detected) or `'force'`. Not needed for `normalize: false` or when validation passes in `'auto'` mode.

## Directory layout

- Under the path you pass to `uploadHLS({ path })`, there must be **exactly one** `.m3u8` file (searched recursively). If there are zero or more than one, the client throws.
- That playlist must be a **media playlist** (contains segment entries). **Master playlists** (variants only, no segments) are **not** supported — flatten to a single variant directory first.
- Segment URIs in the playlist must point to **`.ts`** files. Other URIs are **skipped** (optional `debug: true` logs skips).
- Each segment URI must resolve to a **single path segment** (no `/` in the stored object name): nested segment paths are rejected.
- Paths must stay **under the playlist's directory** (no `..` escape).

## Smart Normalize Pipeline

The SDK includes a built-in normalize pipeline that validates HLS/TS integrity and optionally remuxes content before upload. This ensures Safari compatibility and keeps segments within provider size limits.

### Normalize Modes

| Mode | Behavior |
|------|----------|
| `false` | Upload raw HLS without any validation or remux. |
| `'auto'` (default) | Validate HLS + TS. Only normalize/remux if issues detected. |
| `'force'` | Always normalize/remux before upload. |
| `'strict'` | Validate only. Reject upload if unsafe. Never auto-repair. |

### What validation checks

- **TS integrity**: Sync byte (0x47) alignment, packet alignment (divisible by 188 bytes)
- **Segment size**: Detects segments exceeding `maxSegmentSizeMB` (default 5MB)
- **Manifest consistency**: Segment count, missing files, invalid EXTINF durations
- **Safari risk heuristics**: Packet misalignment, inconsistent segment durations

### How normalization works

When normalization is triggered, the pipeline:

1. **Probes** the input using ffprobe (bitrate, duration, codec info)
2. **Remuxes to MP4**: `ffmpeg -i input.m3u8 -map 0 -c copy temp.mp4`
3. **Regenerates HLS**: `ffmpeg -i temp.mp4 -c copy -f hls -hls_time <N> output.m3u8`

The `hls_time` is dynamically calculated from bitrate to keep segments under `maxSegmentSizeMB`:

```
target_duration = (maxSegmentSizeMB * 8) / bitrateMbps
clamped to [2s, 6s]
```

**Important**: This is a transmux pipeline (`-c copy`). It does NOT re-encode, change codecs, alter resolution, or degrade quality.

## Flow (what the SDK does)

```text
uploadHLS()
    ↓
validate HLS + TS (unless normalize: false)
    ↓
decide normalize strategy
    ↓
(optional) normalize/remux via ffmpeg
    ↓
POST /api/v1/videos/init-hls-upload
    ↓
PUT segments (parallel, with retry)
    ↓
PUT playlist
    ↓
POST complete
    ↓
poll until ready
```

## Example

```ts
import { VcdnClient } from "@vcdn/node";

const client = new VcdnClient({
  apiKey: process.env.VCDN_API_KEY!,
  baseUrl: process.env.VCDN_BASE_URL!,
  debug: true,
});

const out = await client.uploadHLS({
  path: "/path/to/hls-out",
  title: "Episode 12 - 720p HLS",
  concurrency: 8,
  signal: new AbortController().signal,
  metrics: true,

  // Normalize options
  normalize: "auto",           // 'auto' | 'force' | 'strict' | false
  maxSegmentSizeMB: 5,         // Max segment size before triggering normalize
  ffmpegPath: "/usr/bin/ffmpeg", // Optional: auto-detected from PATH
  tempDir: "./tmp",            // Optional: defaults to os.tmpdir()
  ffmpegTimeoutMs: 300_000,    // Optional: 5 min default

  onProgress(event) {
    if (typeof event === "number") {
      // Legacy: upload percent only (when normalize: false)
      console.log(`Upload: ${event}%`);
    } else {
      // Rich progress with phase info
      console.log(`[${event.phase}] ${event.progress}%`, event.detail ?? "");
    }
  },
});

console.log(out.video_id);
console.log(out.normalized);    // true if normalization was applied
console.log(out.validation);    // ValidationResult object
```

## Options (`UploadHLSOptions`)

| Field | Description |
|--------|-------------|
| `path` | Root directory to scan for the single `.m3u8`. |
| `title` | Optional display title for the created video. Defaults to `HLS SDK Upload`. |
| `concurrency` | Parallel segment uploads; clamped **5–10**, default **8**. |
| `onProgress` | Progress callback: receives `NormalizeProgressEvent` or `number` (0–100). |
| `signal` | `AbortSignal` to cancel in-flight work. |
| `waitTimeoutMs` | Max wait for `ready` after complete; default **900000** (15 min). |
| `pollIntervalMs` | Poll interval for readiness; default **2000** ms. |
| `metrics` | If `true`, result includes `bytesUploaded` and `segmentUploadMs`. |
| `checksum` | If `true`, sends `X-Segment-Sha256` per segment (server may ignore). |
| `normalize` | Normalize mode: `false` \| `'auto'` \| `'force'` \| `'strict'`. Default `'auto'`. |
| `maxSegmentSizeMB` | Max segment size in MB. Default **5**. |
| `ffmpegPath` | Custom ffmpeg path. Auto-detected if omitted. |
| `ffprobePath` | Custom ffprobe path. Auto-detected if omitted. |
| `tempDir` | Temp directory root. Default `os.tmpdir()`. |
| `ffmpegTimeoutMs` | Timeout per ffmpeg operation. Default **300000** (5 min). |

## Result (`UploadHLSResult`)

- `video_id`, `upload_id`, `status: "ready"` when the method resolves.
- `normalized: boolean` — whether normalization was applied.
- `validation: ValidationResult` — validation details (when normalize !== false).
- Optional `bytesUploaded`, `segmentUploadMs` when `metrics: true`.

## Progress Phases

When normalize is active, progress events include phase information:

| Phase | Progress Range | Description |
|-------|---------------|-------------|
| `validating` | 0–10 | TS integrity + manifest checks |
| `probing` | 10–20 | ffprobe analysis |
| `normalizing` | 20–40 | TS → MP4 remux |
| `regenerating` | 40–50 | MP4 → HLS regeneration |
| `uploading` | 50–95 | Segment + playlist upload |
| `cleaning` | 95–99 | Temp file cleanup |
| `done` | 100 | Complete |

## Errors

HLS-specific failures use **`VcdnHlsError`** (`name: "VcdnHlsError"`, `code`, optional `detail`).

| `code` | Meaning |
|--------|---------|
| `CONFIG` | Missing `baseUrl` / `baseURL` or `apiKey`. |
| `NO_PLAYLIST` | No `.m3u8` under `path`. |
| `MULTIPLE_PLAYLISTS` | More than one `.m3u8` under `path`. |
| `MASTER_PLAYLIST` | Master playlist (variants, no segments). |
| `NO_TS_SEGMENTS` | No `.ts` URIs in the playlist. |
| `INVALID_SEGMENT_URI` | Bad or empty segment URI after sanitize. |
| `NESTED_SEGMENT_PATH` | Segment URI contains a path separator. |
| `PATH_TRAVERSAL` | Segment resolves outside the playlist directory. |
| `MISSING_SEGMENT` / `EMPTY_SEGMENT` | File missing or zero size. |
| `WAIT_TIMEOUT` | Video did not become `ready` in time. |
| `VIDEO_FAILED` | Server reported `failed` status. |
| `HTTP_ERROR` / `REQUEST_FAILED` | HTTP or network failure (see `message` / `detail`). |
| `VALIDATION_FAILED` | Strict mode: HLS failed validation. |
| `FFMPEG_NOT_FOUND` | ffmpeg/ffprobe not in PATH and no custom path provided. |
| `FFMPEG_FAILED` | ffmpeg process exited non-zero. |
| `FFMPEG_TIMEOUT` | ffmpeg exceeded timeout. |
| `NORMALIZE_FAILED` | Normalize pipeline produced invalid output. |
| `PROBE_FAILED` | ffprobe could not analyze the input. |

Aborting via `signal` throws **`AbortError`** (`DOMException`).

## Graceful Degradation

In `'auto'` mode:
- If ffmpeg is not installed but normalization is needed, the SDK **warns** and uploads raw (does not fail).
- If probing fails, normalization continues with default segment duration.
- If normalization itself fails, the SDK falls back to raw upload.

In `'force'` mode:
- All of the above become hard errors (throws `VcdnHlsError`).

## Standalone Utilities

The normalize pipeline modules are exported for standalone use:

```ts
import {
  validateHLS,
  probeHLS,
  normalizeHLS,
  calculateHlsTime,
  detectFfmpeg,
  TempWorkspace,
} from "@vcdn/node";

// Validate without uploading
const validation = await validateHLS("/path/to/playlist.m3u8", "/path/to/root");

// Probe stream info
const probe = await probeHLS("/path/to/playlist.m3u8");

// Calculate optimal segment duration
const hlsTime = calculateHlsTime(probe.bitrateBps, 5); // 5MB max
```

## HTTP reference (curl, status codes)

In the monorepo (relative to `repos/sdk`):

- `../../backend/docs/developer-api.md` — HLS upload sections and examples.
- `../../backend/infra/api/openapi-v1.yaml` — OpenAPI for `/api/v1/videos/*` HLS routes.

## Related

- Browser multipart upload: **`VcdnBrowserClient`** in `@vcdn/browser` — not HLS-directory upload.
- Publishing and git consumption: [consumption.md](./consumption.md).
- Architecture plan: [sdk-node-hls-normalize-pipeline.md](../../plans/sdk-node-hls-normalize-pipeline.md).
