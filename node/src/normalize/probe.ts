/**
 * FFprobe wrapper for HLS stream analysis.
 *
 * Runs ffprobe to detect bitrate, codec info, duration,
 * continuity errors, timestamp issues, and PES corruption.
 */

import { detectFfprobe, runFfprobe } from "./ffmpeg.js";
import type { ProbeResult } from "./types.js";

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  nb_streams?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  bit_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

/**
 * Probe an HLS playlist or TS file using ffprobe.
 *
 * Extracts:
 * - Overall bitrate
 * - Duration
 * - Video/audio codec info
 * - Continuity counter errors (from stderr warnings)
 * - Timestamp errors
 * - PES corruption indicators
 *
 * @param inputPath - Path to .m3u8 playlist or .ts file.
 * @param options - Probe options.
 */
export async function probeHLS(
  inputPath: string,
  options?: {
    ffprobePath?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ProbeResult> {
  const ffprobePath = await detectFfprobe(options?.ffprobePath);
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const signal = options?.signal;

  // Run ffprobe with JSON output for format and stream info
  const jsonOutput = await runFfprobe({
    args: [
      "-v", "warning",
      "-show_format",
      "-show_streams",
      "-of", "json",
      "-i", inputPath,
    ],
    ffprobePath,
    timeoutMs,
    signal,
  });

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(jsonOutput) as FfprobeOutput;
  } catch {
    throw new Error(
      `ffprobe returned invalid JSON. Output: ${jsonOutput.slice(0, 500)}`,
    );
  }

  // Extract format info
  const format = parsed.format;
  const streams = parsed.streams ?? [];

  const bitrateBps = format?.bit_rate ? parseInt(format.bit_rate, 10) : 0;
  const durationSec = format?.duration ? parseFloat(format.duration) : 0;

  // Find video and audio streams
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  const videoCodec = videoStream?.codec_name ?? "unknown";
  const audioCodec = audioStream?.codec_name ?? null;
  const hasAudio = audioStream != null;

  // Run a second pass to detect continuity and timestamp errors
  // Use -count_packets and capture stderr warnings
  let continuityErrors = 0;
  const timestampErrors: string[] = [];
  let pesCorruption = false;

  try {
    const errorOutput = await runFfprobe({
      args: [
        "-v", "warning",
        "-count_packets",
        "-show_entries", "stream=nb_read_packets",
        "-of", "csv=p=0",
        "-i", inputPath,
      ],
      ffprobePath,
      timeoutMs,
      signal,
    });

    // Parse stderr-like warnings from the output
    // ffprobe outputs warnings to stderr which we capture
    // The runFfprobe returns stdout; warnings go to stderr and cause non-zero exit
    // So we handle this in a try/catch
  } catch (err) {
    // ffprobe may exit non-zero when there are warnings
    // Parse the error message for continuity/timestamp issues
    const errMsg = err instanceof Error ? err.message : String(err);

    // Count continuity counter errors
    const ccMatches = errMsg.match(/continuity/gi);
    if (ccMatches) {
      continuityErrors = ccMatches.length;
    }

    // Detect timestamp errors
    const tsErrors = errMsg.match(/dts.*out of order|pts.*invalid|timestamp.*discontinuity/gi);
    if (tsErrors) {
      timestampErrors.push(...tsErrors.slice(0, 10)); // Cap at 10
    }

    // Detect PES corruption
    if (/pes.*corrupt|invalid pes|pes.*error/i.test(errMsg)) {
      pesCorruption = true;
    }
  }

  // If bitrate is 0, try to estimate from stream bitrates
  let effectiveBitrate = bitrateBps;
  if (effectiveBitrate === 0) {
    for (const stream of streams) {
      if (stream.bit_rate) {
        effectiveBitrate += parseInt(stream.bit_rate, 10) || 0;
      }
    }
  }

  // Fallback: estimate from file size and duration if still 0
  // This will be handled by the caller if needed

  return {
    bitrateBps: effectiveBitrate,
    durationSec,
    videoCodec,
    audioCodec,
    hasAudio,
    continuityErrors,
    timestampErrors,
    pesCorruption,
  };
}
