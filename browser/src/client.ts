import {
  createHttpClient,
  type HttpClient,
  type UploadChunkResponse,
  type UploadCompleteResponse,
  type UploadInitRequest,
  type UploadPart,
  type UploadProgress,
  type UploadSession,
  type UploadStatusResponse,
} from "@vcdn/sdk-shared";

const DEFAULT_CHUNK = 8 * 1024 * 1024;

export interface VcdnBrowserClientOptions {
  apiKey: string;
  /** Origin of upload-service, e.g. `http://localhost:8082` (no `/api/v1` suffix). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface UploadFileOptions {
  chunkSize?: number;
  /**
   * Reserved for API compatibility. The server accepts one in-flight chunk per upload session;
   * uploads are performed sequentially regardless of this value.
   */
  concurrency?: number;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** When true (default), fetches server status before sending bytes to support resume. */
  resume?: boolean;
  /** Continue an existing session (no new init). */
  uploadId?: string;
  /** Merged into the init request body for new uploads. */
  init?: Partial<UploadInitRequest>;
}

function sliceFile(file: File, start: number, length: number): Blob {
  return file.slice(start, start + length);
}

function sessionFromStatus(st: UploadStatusResponse): UploadSession {
  const uploadUrl =
    typeof st.uploadUrl === "string" && st.uploadUrl.trim() !== ""
      ? st.uploadUrl.trim()
      : `/api/v1/upload/${encodeURIComponent(st.uploadId)}/chunk`;
  return {
    uploadId: st.uploadId,
    videoId: st.videoId,
    projectId: "",
    uploadUrl,
  };
}

export class VcdnBrowserClient {
  private readonly http: HttpClient;

  constructor(opts: VcdnBrowserClientOptions) {
    this.http = createHttpClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }

  async createUpload(
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

  async getUploadStatus(
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<UploadStatusResponse> {
    return this.http.requestJson<UploadStatusResponse>({
      method: "GET",
      path: `/api/v1/upload/${encodeURIComponent(uploadId)}/status`,
      signal,
    });
  }

  /** Returns the `parts` array from the server status (often empty; use status bytes for resume). */
  async getUploadParts(
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<UploadPart[]> {
    const s = await this.getUploadStatus(uploadId, signal);
    return Array.isArray(s.parts) ? s.parts : [];
  }

  async postChunk(
    uploadId: string,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<UploadChunkResponse> {
    const buf = await chunk.arrayBuffer();
    return this.http.requestBytes<UploadChunkResponse>({
      path: `/api/v1/upload/${encodeURIComponent(uploadId)}/chunk`,
      body: buf,
      signal,
      retry: { maxAttempts: 4, baseDelayMs: 250 },
    });
  }

  async completeUpload(
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

  /**
   * Multipart upload: init → sequential raw chunks → complete.
   * When `resume` is true, fetches server status and continues from `bytesReceived`.
   */
  async uploadFile(
    file: File,
    options: UploadFileOptions = {},
  ): Promise<UploadCompleteResponse> {
    const signal = options.signal;
    const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK);
    const doResume = options.resume !== false;

    let session: UploadSession;
    let uploadId: string;
    let offset = 0;

    if (options.uploadId) {
      uploadId = options.uploadId;
      const st = await this.getUploadStatus(uploadId, signal);
      if (st.sizeBytes != null && st.sizeBytes !== file.size) {
        throw new Error(
          `file size ${file.size} does not match server declared size ${st.sizeBytes}`,
        );
      }
      session = sessionFromStatus(st);
      if (doResume) {
        offset = Number(st.bytesReceived) || 0;
      }
    } else {
      const initBody: UploadInitRequest = {
        filename: file.name,
        size: file.size,
        contentType: file.type || "video/mp4",
        title: file.name,
        ...options.init,
      };
      session = await this.createUpload(initBody, signal);
      uploadId = session.uploadId;
      if (doResume) {
        const st = await this.getUploadStatus(uploadId, signal);
        if (st.sizeBytes != null && st.sizeBytes !== file.size) {
          throw new Error(
            `file size ${file.size} does not match server declared size ${st.sizeBytes}`,
          );
        }
        offset = Number(st.bytesReceived) || 0;
      }
    }

    let loaded = offset;
    const total = file.size;
    uploadId = session.uploadId;
    options.onProgress?.({ loaded, total, uploadId });

    while (loaded < total) {
      const n = Math.min(chunkSize, total - loaded);
      const blob = sliceFile(file, loaded, n);
      const out = await this.postChunk(uploadId, blob, signal);
      loaded = out.bytesReceived;
      options.onProgress?.({ loaded, total, uploadId });
    }

    return this.completeUpload(uploadId, signal);
  }
}
