/**
 * Smart HLS Normalize Pipeline — shared types.
 *
 * These types define the public contract for validation, normalization,
 * and progress reporting throughout the pipeline.
 */

// ─── Normalize Mode ─────────────────────────────────────────────────────────

/**
 * Controls how the SDK handles HLS validation and normalization before upload.
 *
 * - `false`   — Upload raw HLS without any validation or remux.
 * - `'auto'`  — Validate; normalize only if issues detected (DEFAULT).
 * - `'force'` — Always normalize/remux before upload.
 * - `'strict'`— Validate only; reject upload if unsafe; never auto-repair.
 */
export type NormalizeMode = false | "auto" | "force" | "strict";

// ─── Normalize Options ──────────────────────────────────────────────────────

export interface NormalizeOptions {
  /** Normalize mode. Default: 'auto' */
  normalize?: NormalizeMode;
  /** Max segment size in MB. Default: 5 */
  maxSegmentSizeMB?: number;
  /** Custom ffmpeg binary path. Auto-detected if omitted. */
  ffmpegPath?: string;
  /** Custom ffprobe binary path. Auto-detected if omitted. */
  ffprobePath?: string;
  /** Temp directory root. Default: os.tmpdir() */
  tempDir?: string;
  /** Timeout for individual ffmpeg operations in ms. Default: 300_000 (5 min) */
  ffmpegTimeoutMs?: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface SegmentValidation {
  /** Segment filename (relative to playlist dir). */
  filename: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** True if first byte is 0x47 (TS sync byte). */
  syncAligned: boolean;
  /** True if file size is divisible by 188. */
  packetAligned: boolean;
  /** True if segment exceeds maxSegmentSizeMB. */
  oversized: boolean;
}

export interface ValidationResult {
  /** True if no errors were found. */
  valid: boolean;
  /** True if heuristics suggest Safari playback risk. */
  safariRisk: boolean;
  /** True if any segment exceeds maxSegmentSizeMB. */
  oversizedSegments: boolean;
  /** True if the pipeline recommends normalization. */
  needsNormalize: boolean;
  /** Hard errors that prevent safe playback. */
  errors: string[];
  /** Soft warnings (may still play but risky). */
  warnings: string[];
  /** Per-segment validation details. */
  segments: SegmentValidation[];
}

// ─── Probe ──────────────────────────────────────────────────────────────────

export interface ProbeResult {
  /** Overall bitrate in bits per second. */
  bitrateBps: number;
  /** Total duration in seconds. */
  durationSec: number;
  /** Video codec name (e.g. 'h264', 'hevc'). */
  videoCodec: string;
  /** Audio codec name (e.g. 'aac', 'mp3') or null if no audio. */
  audioCodec: string | null;
  /** True if audio stream is present. */
  hasAudio: boolean;
  /** Number of continuity counter errors detected. */
  continuityErrors: number;
  /** Timestamp-related error messages from ffprobe. */
  timestampErrors: string[];
  /** True if PES packet corruption was detected. */
  pesCorruption: boolean;
}

// ─── Progress ───────────────────────────────────────────────────────────────

export type NormalizePhase =
  | "validating"
  | "probing"
  | "normalizing"
  | "regenerating"
  | "uploading"
  | "cleaning"
  | "done";

export interface NormalizeProgressEvent {
  phase: NormalizePhase;
  /** Progress within the overall pipeline, 0–100. */
  progress: number;
  /** Optional human-readable detail. */
  detail?: string;
}

// ─── Normalize Pipeline ─────────────────────────────────────────────────────

export interface NormalizePipelineOptions {
  /** Path to the input media playlist (.m3u8). */
  inputPlaylistPath: string;
  /** Directory to write normalized output. */
  outputDir: string;
  /** Max segment size in MB. */
  maxSegmentSizeMB: number;
  /** Resolved ffmpeg binary path. */
  ffmpegPath: string;
  /** Timeout for each ffmpeg invocation in ms. */
  timeoutMs: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: NormalizeProgressEvent) => void;
  /** Pre-probed bitrate in bps (avoids re-probing). */
  probedBitrate?: number;
}

export interface NormalizePipelineResult {
  /** Path to the output media playlist. */
  playlistPath: string;
  /** Paths to all output TS segments. */
  segmentPaths: string[];
}

// ─── FFmpeg ─────────────────────────────────────────────────────────────────

export interface FfmpegRunOptions {
  /** ffmpeg arguments (excluding the binary name). */
  args: string[];
  /** Resolved ffmpeg binary path. */
  ffmpegPath: string;
  /** Timeout in ms. Default: 300_000. */
  timeoutMs?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Progress callback (0–100). */
  onProgress?: (percent: number) => void;
  /** Expected total duration in seconds (for progress calculation). */
  durationSec?: number;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

export interface ManifestSegmentInfo {
  /** Raw URI from the playlist. */
  uri: string;
  /** EXTINF duration in seconds. */
  duration: number;
  /** Sequence number (derived from media sequence + index). */
  sequence: number;
  /** Absolute path to the segment file on disk. */
  absPath: string;
}

export interface ManifestParseResult {
  /** Parsed segment entries. */
  segments: ManifestSegmentInfo[];
  /** Target duration from the playlist header. */
  targetDuration: number;
  /** Hard errors found during parsing. */
  errors: string[];
  /** Soft warnings. */
  warnings: string[];
}
