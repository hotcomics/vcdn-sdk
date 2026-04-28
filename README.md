# VCDN SDK Workspace

TypeScript SDK workspace for the upload-service public API (`/api/v1/*`), including browser client, node client, and shared core.

## Packages

- `shared/` -> `@vcdn/sdk-shared`: shared types, HTTP client, and error model.
- `browser/` -> `@vcdn/browser`: browser multipart upload + resume.
- `node/` -> `@vcdn/node`: Node upload + video APIs + playback token.

## Prerequisites

- Node.js `>=18`
- pnpm `9.x`
- `baseUrl` must be origin only, for example `http://localhost:8082`
- Do not append `/api/v1` to `baseUrl` (SDK handles endpoint paths)

## Install and Build

```bash
pnpm install
pnpm build
```

## Workspace Scripts

- `pnpm build`: build `@vcdn/sdk-shared`, `@vcdn/browser`, `@vcdn/node`.
- `pnpm typecheck`: type-check all packages.
- `pnpm clean`: remove build outputs.
- `pnpm pack:dry-run`: create package tarballs in `.artifacts/`.
- `pnpm publish:check`: run build + typecheck + dry-run packaging.

## Link Local Packages in Another App

```json
{
  "dependencies": {
    "@vcdn/browser": "file:../sdk/browser",
    "@vcdn/node": "file:../sdk/node"
  }
}
```

## Authentication

Both clients send API key via `X-API-Key` header.

## Browser SDK (`@vcdn/browser`)

### Create browser client

```ts
import { VcdnBrowserClient } from "@vcdn/browser";

const client = new VcdnBrowserClient({
  apiKey: process.env.NEXT_PUBLIC_VCDN_API_KEY!,
  baseUrl: process.env.NEXT_PUBLIC_VCDN_BASE_URL!,
});
```

### Upload file (auto init + resume + complete)

```ts
const out = await client.uploadFile(file, {
  chunkSize: 8 * 1024 * 1024,
  resume: true,
  onProgress: ({ loaded, total }) => {
    console.log(Math.round((loaded / total) * 100) + "%");
  },
  init: {
    title: file.name,
    quality: "1080p",
    ladderProfile: "full",
  },
});
```

### Manual flow

1. `createUpload(...)`
2. `postChunk(uploadId, blob)` in sequence
3. `completeUpload(uploadId)`

## Node SDK (`@vcdn/node`)

### Create node client

```ts
import { VcdnNodeClient } from "@vcdn/node";

const client = new VcdnNodeClient({
  apiKey: process.env.VCDN_API_KEY!,
  baseUrl: process.env.VCDN_BASE_URL!,
});
```

### Upload from file path

```ts
await client.uploadFileFromPath(
  "/tmp/video.mp4",
  { title: "Release demo", quality: "720p", ladderProfile: "standard" },
  { chunkSize: 8 * 1024 * 1024 },
);
```

### Video APIs + playback token

```ts
const list = await client.listVideos({ page: 1, limit: 20 });
const video = await client.getVideo(list.items[0].id);
const playback = await client.createPlaybackToken(video.id, { ttlSeconds: 600 });
console.log(playback.streamUrl);
```

## Error handling

Both SDKs throw `VcdnApiError` on non-2xx responses.

```ts
import { VcdnApiError } from "@vcdn/browser";

try {
  // call SDK
} catch (err) {
  if (err instanceof VcdnApiError) {
    console.error(err.status, err.code, err.message, err.detail);
  }
}
```

## API coverage

- Upload:
  - `POST /api/v1/upload/init`
  - `GET /api/v1/upload/{uploadId}/status`
  - `POST /api/v1/upload/{uploadId}/chunk`
  - `POST /api/v1/upload/complete`
- Video:
  - `GET /api/v1/videos`
  - `GET /api/v1/videos/{id}`
  - `DELETE /api/v1/videos/{id}`
  - `POST /api/v1/videos/{id}/playback-token`

## Notes

- Upload chunks are processed sequentially (1 in-flight chunk per `uploadId`).
- The browser `concurrency` option is kept for compatibility and does not change sequential behavior.
- `projectId` is derived by the server from API key scope.
