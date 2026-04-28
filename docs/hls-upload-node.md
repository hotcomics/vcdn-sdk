# HLS directory upload (Node)

The `@vcdn/node` package exposes **`VcdnClient`** (`import { VcdnClient } from "@vcdn/node"`), separate from **`VcdnNodeClient`**, for uploading a **local HLS pack** (one media `.m3u8` and referenced `.ts` segments) to the upload-service public API.

`VcdnNodeClient` covers multipart file upload, video listing, and playback tokens. Use **`VcdnClient`** when you already have an HLS output directory on disk.

## Requirements

- **Node.js** `>=18`
- **API key** with access to the upload origin (sent as `X-API-Key`).
- **`baseUrl` / `baseURL`**: origin only, e.g. `https://upload.example.com` — do **not** append `/api/v1`.

## Directory layout

- Under the path you pass to `uploadHLS({ path })`, there must be **exactly one** `.m3u8` file (searched recursively). If there are zero or more than one, the client throws.
- That playlist must be a **media playlist** (contains segment entries). **Master playlists** (variants only, no segments) are **not** supported — flatten to a single variant directory first.
- Segment URIs in the playlist must point to **`.ts`** files. Other URIs are **skipped** (optional `debug: true` logs skips).
- Each segment URI must resolve to a **single path segment** (no `/` in the stored object name): nested segment paths are rejected.
- Paths must stay **under the playlist’s directory** (no `..` escape).

## Flow (what the SDK does)

1. `POST /api/v1/videos/init-hls-upload` → `video_id`, `upload_id`.
2. For each `.ts` in playlist order: `HEAD` segment URL → skip if `200`; on `404`, `PUT` body as `video/MP2T`, optional `X-Segment-Sha256` hex if `checksum: true`.
3. `PUT` the media playlist as `application/vnd.apple.mpegurl`.
4. `POST /api/v1/videos/{id}/complete`.
5. Poll `GET /api/v1/videos/{id}` until `status === "ready"` (or `failed` / timeout).

Retries apply to transient HTTP failures (with backoff). Concurrency for segment uploads is clamped between **5 and 10** (default **8**).

## Example

```ts
import { VcdnClient } from "@vcdn/node";

const client = new VcdnClient({
  apiKey: process.env.VCDN_API_KEY!,
  baseUrl: process.env.VCDN_BASE_URL!,
  // debug: true,
});

const ac = new AbortController();
// setTimeout(() => ac.abort(), 60_000);

const out = await client.uploadHLS({
  path: "/path/to/hls-out",
  concurrency: 8,
  onProgress: (pct) => console.log(`${pct}%`),
  signal: ac.signal,
  waitTimeoutMs: 900_000,
  pollIntervalMs: 2000,
  metrics: true,
  checksum: false,
});

console.log(out.video_id, out.upload_id, out.bytesUploaded, out.segmentUploadMs);
```

## Options (`UploadHLSOptions`)

| Field | Description |
|--------|-------------|
| `path` | Root directory to scan for the single `.m3u8`. |
| `concurrency` | Parallel segment uploads; clamped **5–10**, default **8**. |
| `onProgress` | `0–100` as segments finish (uploaded or skipped). |
| `signal` | `AbortSignal` to cancel in-flight work. |
| `waitTimeoutMs` | Max wait for `ready` after complete; default **900000** (15 min). |
| `pollIntervalMs` | Poll interval for readiness; default **2000** ms. |
| `metrics` | If `true`, result includes `bytesUploaded` and `segmentUploadMs`. |
| `checksum` | If `true`, sends `X-Segment-Sha256` per segment (server may ignore). |

## Result (`UploadHLSResult`)

- `video_id`, `upload_id`, `status: "ready"` when the method resolves.
- Optional `bytesUploaded`, `segmentUploadMs` when `metrics: true`.

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

Aborting via `signal` throws **`AbortError`** (`DOMException`).

## HTTP reference (curl, status codes)

In the monorepo (relative to `repos/sdk`):

- `../../backend/docs/developer-api.md` — HLS upload sections and examples.
- `../../backend/infra/api/openapi-v1.yaml` — OpenAPI for `/api/v1/videos/*` HLS routes.

## Related

- Browser multipart upload: **`VcdnBrowserClient`** in `@vcdn/browser` — not HLS-directory upload.
- Publishing and git consumption: [consumption.md](./consumption.md).
