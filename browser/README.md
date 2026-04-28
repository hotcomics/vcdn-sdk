# @vcdn/browser

Browser SDK for the VCDN upload-service public API. It handles multipart uploads from `File` objects, supports resume from server status, and exports shared upload types.

## Install

```bash
pnpm add @vcdn/browser
```

## Create a Client

```ts
import { VcdnBrowserClient } from "@vcdn/browser";

const client = new VcdnBrowserClient({
  apiKey: process.env.NEXT_PUBLIC_VCDN_API_KEY!,
  baseUrl: process.env.NEXT_PUBLIC_VCDN_BASE_URL!,
});
```

`baseUrl` must be the upload-service origin only, for example `https://upload.example.com`. Do not append `/api/v1`.

## Upload a File

```ts
const result = await client.uploadFile(file, {
  chunkSize: 8 * 1024 * 1024,
  resume: true,
  onProgress: ({ loaded, total, uploadId }) => {
    console.log(uploadId, Math.round((loaded / total) * 100));
  },
  init: {
    title: file.name,
    quality: "1080p",
    ladderProfile: "full",
  },
});

console.log(result.videoId, result.status);
```

`uploadFile` creates an upload session when `uploadId` is not provided, sends raw chunks sequentially, then completes the upload.

## Resume an Existing Upload

```ts
await client.uploadFile(file, {
  uploadId: "existing-upload-id",
  resume: true,
});
```

When resume is enabled, the SDK reads `/api/v1/upload/{uploadId}/status` and continues from `bytesReceived`.

## Manual Flow

```ts
const session = await client.createUpload({
  filename: file.name,
  size: file.size,
  contentType: file.type || "video/mp4",
  title: file.name,
});

await client.postChunk(session.uploadId, file.slice(0, file.size));
const completed = await client.completeUpload(session.uploadId);
```

Manual upload APIs:

- `createUpload(body, signal?)`
- `getUploadStatus(uploadId, signal?)`
- `getUploadParts(uploadId, signal?)`
- `postChunk(uploadId, chunk, signal?)`
- `completeUpload(uploadId, signal?)`

## Error Handling

```ts
import { VcdnApiError } from "@vcdn/browser";

try {
  await client.completeUpload("upload-id");
} catch (err) {
  if (err instanceof VcdnApiError) {
    console.error(err.status, err.code, err.message, err.detail);
  }
}
```

## Development

```bash
pnpm --dir browser build
pnpm --dir browser typecheck
```
