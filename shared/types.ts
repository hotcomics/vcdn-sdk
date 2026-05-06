/** Video metadata (snake_case from upload-service). */
export interface Video {
  id: string;
  title: string;
  status: string;
  transcode_progress: number;
  transcode_attempts: number;
  error?: string | null;
  duration_sec?: number | null;
  poster_url?: string | null;
  embed_url: string;
  created_at: string;
}

export interface VideoListResponse {
  items: Video[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextPage?: number | null;
}

/** Response from POST /api/v1/upload/init */
export interface UploadSession {
  uploadId: string;
  videoId: string;
  projectId: string;
  uploadUrl: string;
}

export interface UploadInitRequest {
  filename: string;
  size: number;
  contentType?: string;
  title?: string;
  /** Optional dashboard/BFF workspace hint. Public API deployments may ignore it and derive scope from the API key. */
  projectId?: string;
  quality?: "360p" | "720p" | "1080p";
  ladderProfile?:
    | "debug"
    | "standard"
    | "full"
    | "single_360"
    | "single_720"
    | "single_1080";
}

export interface UploadChunkResponse {
  uploadId: string;
  received: number;
  bytesReceived: number;
  bytesReceivedWas: number;
}

export interface UploadCompleteRequest {
  uploadId: string;
}

export interface UploadCompleteResponse {
  videoId: string;
  status: string;
  objectKey: string;
  uploadId: string;
}

/** Part bookkeeping (reserved; server may return an empty list). */
export interface UploadPart {
  partNumber: number;
  sizeBytes?: number;
}

/** GET /api/v1/upload/{uploadId}/status */
export interface UploadStatusResponse {
  uploadId: string;
  videoId: string;
  status: string;
  bytesReceived: number;
  sizeBytes?: number | null;
  nextPartNumber?: number | null;
  uploadUrl?: string | null;
  parts: UploadPart[];
}

export interface PlaybackTokenRequest {
  ttlSeconds?: number;
}

export interface PlaybackResponse {
  token: string;
  exp: number;
  streamUrl: string;
  videoId: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  uploadId?: string;
}
