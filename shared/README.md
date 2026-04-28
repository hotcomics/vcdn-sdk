# @vcdn/sdk-shared

Shared TypeScript types, HTTP helpers, and API error handling for the VCDN browser and Node.js SDKs.

This package is intended as a foundation for SDK packages. Most applications should install `@vcdn/browser` or `@vcdn/node` instead.

## Install

```bash
pnpm add @vcdn/sdk-shared
```

## Exports

- `createHttpClient`: lightweight fetch-based client for the upload-service API.
- `VcdnApiError`: error class thrown for non-2xx API responses.
- Upload types: `UploadSession`, `UploadInitRequest`, `UploadStatusResponse`, `UploadChunkResponse`, `UploadCompleteResponse`, `UploadProgress`.
- Video types: `Video`, `VideoListResponse`, `PlaybackTokenRequest`, `PlaybackResponse`.

## Usage

```ts
import { createHttpClient, VcdnApiError } from "@vcdn/sdk-shared";

const http = createHttpClient({
  apiKey: process.env.VCDN_API_KEY!,
  baseUrl: process.env.VCDN_BASE_URL!,
});

try {
  const videos = await http.requestJson({
    method: "GET",
    path: "/api/v1/videos?page=1&limit=20",
  });

  console.log(videos);
} catch (err) {
  if (err instanceof VcdnApiError) {
    console.error(err.status, err.code, err.message, err.detail);
  }
}
```

## Base URL

Use the upload-service origin only, for example `https://upload.example.com`.

Do not include `/api/v1` in `baseUrl`; endpoint paths passed to the client already include the API prefix.

## Development

```bash
pnpm --dir shared build
pnpm --dir shared typecheck
```
