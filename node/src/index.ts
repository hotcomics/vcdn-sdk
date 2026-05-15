export { VcdnNodeClient } from "./client.js";
export type { VcdnNodeClientOptions } from "./client.js";
export { VcdnClient, VcdnHlsError, sanitizeSegmentName } from "./vcdn-client.js";
export type {
  VcdnClientOptions,
  UploadHLSOptions,
  UploadHLSResult,
  WaitUntilReadyOptions,
} from "./vcdn-client.js";
export type {
  Video,
  VideoListResponse,
  UploadSession,
  UploadInitRequest,
  UploadCompleteResponse,
  PlaybackResponse,
  PlaybackTokenRequest,
} from "@vcdn/sdk-shared";
export { VcdnApiError } from "@vcdn/sdk-shared";

// ─── Normalize Pipeline Exports ─────────────────────────────────────────────
export {
  TempWorkspace,
  parseAndValidateManifest,
  validateHLS,
  detectFfmpeg,
  detectFfprobe,
  runFfmpeg,
  probeHLS,
  normalizeHLS,
  calculateHlsTime,
} from "./normalize/index.js";
export type {
  NormalizeMode,
  NormalizeOptions,
  NormalizePhase,
  NormalizeProgressEvent,
  NormalizePipelineOptions,
  NormalizePipelineResult,
  ValidationResult,
  SegmentValidation,
  ProbeResult,
  ManifestParseResult,
  ManifestSegmentInfo,
  FfmpegRunOptions,
} from "./normalize/index.js";
