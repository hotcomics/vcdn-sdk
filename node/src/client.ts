import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  createHttpClient,
  type HttpClient,
  type PlaybackResponse,
  type PlaybackTokenRequest,
  type UploadCompleteResponse,
  type UploadInitRequest,
  type UploadSession,
  type Video,
  type VideoListResponse,
} from "@vcdn/sdk-shared";

export interface VcdnNodeClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class VcdnNodeClient {
  private readonly http: HttpClient;

  constructor(opts: VcdnNodeClientOptions) {
    this.http = createHttpClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }

  /** Alias: starts an ingest session (same as `createUploadSession`). */
  createVideo(
    body: UploadInitRequest,
    signal?: AbortSignal,
  ): Promise<UploadSession> {
    return this.createUploadSession(body, signal);
  }

  createUploadSession(
    body: UploadInitRequest,
    signal?: AbortSignal,
  ): Promise<UploadSession> {
    return this.http.requestJson<UploadSession>({
      method: "POST",
      path: "/api/v1/upload/init",
      body,
      signal,
    });
  }

  finalizeUpload(
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<UploadCompleteResponse> {
    return this.http.requestJson<UploadCompleteResponse>({
      method: "POST",
      path: "/api/v1/upload/complete",
      body: { uploadId },
      signal,
    });
  }

  getVideo(id: string, signal?: AbortSignal): Promise<Video> {
    return this.http.requestJson<Video>({
      method: "GET",
      path: `/api/v1/videos/${encodeURIComponent(id)}`,
      signal,
    });
  }

  listVideos(
    query?: { page?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<VideoListResponse> {
    const q = new URLSearchParams();
    if (query?.page != null) q.set("page", String(query.page));
    if (query?.limit != null) q.set("limit", String(query.limit));
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return this.http.requestJson<VideoListResponse>({
      method: "GET",
      path: `/api/v1/videos${suffix}`,
      signal,
    });
  }

  async deleteVideo(id: string, signal?: AbortSignal): Promise<void> {
    await this.http.requestJson<undefined>({
      method: "DELETE",
      path: `/api/v1/videos/${encodeURIComponent(id)}`,
      signal,
    });
  }

  createPlaybackToken(
    videoId: string,
    body?: PlaybackTokenRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackResponse> {
    return this.http.requestJson<PlaybackResponse>({
      method: "POST",
      path: `/api/v1/videos/${encodeURIComponent(videoId)}/playback-token`,
      body: body ?? {},
      signal,
    });
  }

  async getPlaybackUrl(
    videoId: string,
    body?: PlaybackTokenRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const r = await this.createPlaybackToken(videoId, body, signal);
    return r.streamUrl;
  }

  /**
   * Stream a local file to the upload session using raw chunk POSTs.
   * Same sequential semantics as the browser client.
   */
  async uploadFileFromPath(
    filePath: string,
    init: Omit<UploadInitRequest, "filename" | "size"> & {
      filename?: string;
    },
    opts?: { chunkSize?: number; signal?: AbortSignal },
  ): Promise<UploadCompleteResponse> {
    const signal = opts?.signal;
    const st = await stat(filePath);
    const filename = init.filename ?? path.basename(filePath);
    const session = await this.createUploadSession(
      {
        filename,
        size: st.size,
        ...init,
      },
      signal,
    );
    const chunkSize = Math.max(1, opts?.chunkSize ?? 8 * 1024 * 1024);
    let offset = 0;
    while (offset < st.size) {
      const len = Math.min(chunkSize, st.size - offset);
      const stream = createReadStream(filePath, { start: offset, end: offset + len - 1 });
      const chunks: Buffer[] = [];
      for await (const c of stream) {
        chunks.push(c as Buffer);
      }
      const buf = Buffer.concat(chunks);
      await this.http.requestBytes<{ bytesReceived: number }>({
        path: `/api/v1/upload/${encodeURIComponent(session.uploadId)}/chunk`,
        body: buf,
        signal,
        retry: { maxAttempts: 4, baseDelayMs: 250 },
      });
      offset += len;
    }
    return this.finalizeUpload(session.uploadId, signal);
  }

  /** Upload a Blob or Buffer as raw chunks (Node 18+). */
  async uploadBlob(
    data: Blob | ArrayBuffer | Uint8Array,
    init: UploadInitRequest,
    opts?: { chunkSize?: number; signal?: AbortSignal },
  ): Promise<UploadCompleteResponse> {
    const signal = opts?.signal;
    const blob =
      data instanceof Blob
        ? data
        : new Blob([data instanceof ArrayBuffer ? new Uint8Array(data) : data]);
    const size = blob.size;
    const session = await this.createUploadSession(
      {
        ...init,
        size,
      },
      signal,
    );
    const chunkSize = Math.max(1, opts?.chunkSize ?? 8 * 1024 * 1024);
    let offset = 0;
    while (offset < size) {
      const n = Math.min(chunkSize, size - offset);
      const slice = blob.slice(offset, offset + n);
      const buf = new Uint8Array(await slice.arrayBuffer());
      await this.http.requestBytes<{ bytesReceived: number }>({
        path: `/api/v1/upload/${encodeURIComponent(session.uploadId)}/chunk`,
        body: buf,
        signal,
        retry: { maxAttempts: 4, baseDelayMs: 250 },
      });
      offset += n;
    }
    return this.finalizeUpload(session.uploadId, signal);
  }
}
