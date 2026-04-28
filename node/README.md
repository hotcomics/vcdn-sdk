# @vcdn/node

Node.js SDK for the VCDN upload-service public API. It supports multipart uploads from local files, Blob/Buffer uploads, video management APIs, playback tokens, and HLS directory ingest.

Requires Node.js `>=18`.

## Install

```bash
pnpm add @vcdn/node
```

## Create a Client

```ts
import { VcdnNodeClient } from "@vcdn/node";

const client = new VcdnNodeClient({
  apiKey: process.env.VCDN_API_KEY!,
  baseUrl: process.env.VCDN_BASE_URL!,
});
```

`baseUrl` must be the upload-service origin only, for example `https://upload.example.com`. Do not append `/api/v1`.

## Upload a Local File

```ts
const result = await client.uploadFileFromPath(
  "/tmp/video.mp4",
  {
    title: "Release demo",
    quality: "720p",
    ladderProfile: "standard",
  },
  {
    chunkSize: 8 * 1024 * 1024,
  },
);

console.log(result.videoId, result.status);
```

## Upload a Blob or Buffer

```ts
const bytes = await fetch("https://example.com/video.mp4").then((res) => res.arrayBuffer());

await client.uploadBlob(bytes, {
  filename: "video.mp4",
  size: bytes.byteLength,
  contentType: "video/mp4",
  title: "Remote import",
});
```

## Video APIs and Playback Tokens

```ts
const list = await client.listVideos({ page: 1, limit: 20 });
const video = await client.getVideo(list.items[0]!.id);
const playback = await client.createPlaybackToken(video.id, { ttlSeconds: 600 });

console.log(playback.streamUrl);
```

Available video APIs:

- `listVideos(query?, signal?)`
- `getVideo(id, signal?)`
- `deleteVideo(id, signal?)`
- `createPlaybackToken(videoId, body?, signal?)`
- `getPlaybackUrl(videoId, body?, signal?)`

## HLS Directory Upload

Use `VcdnClient` when you have one media `.m3u8` playlist and `.ts` segments on disk. Master playlists and multiple `.m3u8` trees under one root are not supported.

```ts
import { VcdnClient } from "@vcdn/node";

const hls = new VcdnClient({
  apiKey: process.env.VCDN_API_KEY!,
  baseUrl: process.env.VCDN_BASE_URL!,
});

const result = await hls.uploadHLS({
  path: "/path/to/hls-output",
  concurrency: 8,
  metrics: true,
  onProgress: (percent) => console.log(`${percent}%`),
});

console.log(result.video_id, result.upload_id);
```

`uploadHLS` uploads missing `.ts` segments, uploads the playlist, completes the video, and waits until the video is `ready`.

## Error Handling

```ts
import { VcdnApiError, VcdnHlsError } from "@vcdn/node";

try {
  await client.getVideo("video-id");
} catch (err) {
  if (err instanceof VcdnApiError) {
    console.error(err.status, err.code, err.message, err.detail);
  }
}

try {
  await hls.uploadHLS({ path: "/path/to/hls-output" });
} catch (err) {
  if (err instanceof VcdnHlsError) {
    console.error(err.code, err.message, err.detail);
  }
}
```

## Development

```bash
pnpm --dir node build
pnpm --dir node typecheck
```
