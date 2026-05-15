/**
 * Normalize/remux pipeline.
 *
 * Implements the two-step normalization:
 *   1. HLS/TS → temporary MP4 (normalize container, rebuild timestamps)
 *   2. MP4 → regenerated HLS (clean TS packets, Safari-compatible)
 *
 * Uses -c copy throughout — this is a transmux pipeline, NOT a transcoder.
 */

import fg from "fast-glob";
import path from "node:path";

import { runFfmpeg } from "./ffmpeg.js";
import type { NormalizePipelineOptions, NormalizePipelineResult } from "./types.js";

/**
 * Calculate optimal HLS segment duration based on bitrate and max segment size.
 *
 * Formula: target_duration = (maxSegmentSizeBytes * 8) / bitrateBps
 * Clamped between 2s and 6s.
 *
 * @param bitrateBps - Stream bitrate in bits per second.
 * @param maxSegmentSizeMB - Maximum segment size in megabytes.
 * @returns Optimal hls_time value in seconds.
 */
export function calculateHlsTime(
  bitrateBps: number,
  maxSegmentSizeMB: number,
): number {
  if (bitrateBps <= 0) {
    // Fallback: use 4s if bitrate is unknown
    return 4;
  }

  const maxBytes = maxSegmentSizeMB * 1024 * 1024;
  const targetDuration = (maxBytes * 8) / bitrateBps;

  // Clamp between 2s and 6s
  return Math.max(2, Math.min(6, Math.floor(targetDuration)));
}

/**
 * Step 1: Normalize HLS/TS input to a temporary MP4 container.
 *
 * This rebuilds timestamps, repairs continuity counters, and sanitizes
 * malformed TS packets by remuxing through the MP4 container format.
 *
 * Command: ffmpeg -i input.m3u8 -map 0 -c copy temp.mp4
 */
async function normalizeToMp4(
  inputPlaylistPath: string,
  outputMp4Path: string,
  options: {
    ffmpegPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
    durationSec?: number;
  },
): Promise<void> {
  await runFfmpeg({
    args: [
      "-y",
      "-i", inputPlaylistPath,
      "-map", "0",
      "-c", "copy",
      "-movflags", "+faststart",
      outputMp4Path,
    ],
    ffmpegPath: options.ffmpegPath,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
    durationSec: options.durationSec,
  });
}

/**
 * Step 2: Regenerate HLS from the normalized MP4.
 *
 * Produces clean TS segments with:
 * - Deterministic sequential naming (seg0000.ts, seg0001.ts, ...)
 * - Normalized timestamps
 * - Safari-compatible packet structure
 * - Segment sizes controlled by hls_time
 *
 * Command: ffmpeg -i temp.mp4 -c copy -f hls -hls_time <N> -hls_playlist_type vod output.m3u8
 */
async function regenerateHLS(
  inputMp4Path: string,
  outputDir: string,
  options: {
    hlsTime: number;
    ffmpegPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
    durationSec?: number;
  },
): Promise<string> {
  const outputPlaylist = path.join(outputDir, "output.m3u8");
  const segmentPattern = path.join(outputDir, "seg%04d.ts");

  await runFfmpeg({
    args: [
      "-y",
      "-i", inputMp4Path,
      "-c", "copy",
      "-f", "hls",
      "-hls_time", String(options.hlsTime),
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", segmentPattern,
      "-hls_list_size", "0",
      outputPlaylist,
    ],
    ffmpegPath: options.ffmpegPath,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
    durationSec: options.durationSec,
  });

  return outputPlaylist;
}

/**
 * Run the full normalize pipeline:
 *   1. Probe bitrate (if not provided)
 *   2. Calculate optimal segment duration
 *   3. Remux HLS/TS → MP4
 *   4. Regenerate MP4 → HLS
 *   5. Return paths to normalized output
 *
 * @param options - Pipeline configuration.
 * @returns Paths to the output playlist and segments.
 */
export async function normalizeHLS(
  options: NormalizePipelineOptions,
): Promise<NormalizePipelineResult> {
  const {
    inputPlaylistPath,
    outputDir,
    maxSegmentSizeMB,
    ffmpegPath,
    timeoutMs,
    signal,
    onProgress,
    probedBitrate,
  } = options;

  // Calculate optimal segment duration
  const hlsTime = calculateHlsTime(probedBitrate ?? 0, maxSegmentSizeMB);

  // Step 1: Normalize to MP4
  const tempMp4 = path.join(outputDir, "normalize-temp.mp4");

  onProgress?.({ phase: "normalizing", progress: 25, detail: "Remuxing to MP4" });

  await normalizeToMp4(inputPlaylistPath, tempMp4, {
    ffmpegPath,
    timeoutMs,
    signal,
    onProgress: (pct) => {
      // Map 0-100 to 25-40 range
      const mapped = 25 + Math.round(pct * 0.15);
      onProgress?.({ phase: "normalizing", progress: mapped });
    },
  });

  // Step 2: Regenerate HLS
  onProgress?.({ phase: "regenerating", progress: 40, detail: `Regenerating HLS (hls_time=${hlsTime}s)` });

  const playlistPath = await regenerateHLS(tempMp4, outputDir, {
    hlsTime,
    ffmpegPath,
    timeoutMs,
    signal,
    onProgress: (pct) => {
      // Map 0-100 to 40-50 range
      const mapped = 40 + Math.round(pct * 0.10);
      onProgress?.({ phase: "regenerating", progress: mapped });
    },
  });

  // Collect output segment paths
  const segmentPaths = await fg("seg*.ts", {
    cwd: outputDir,
    onlyFiles: true,
    absolute: true,
  });

  segmentPaths.sort(); // Ensure deterministic order

  if (segmentPaths.length === 0) {
    throw new Error(
      "Normalize pipeline produced no output segments. The input may be empty or corrupted.",
    );
  }

  onProgress?.({ phase: "regenerating", progress: 50, detail: `Produced ${segmentPaths.length} segments` });

  return { playlistPath, segmentPaths };
}
