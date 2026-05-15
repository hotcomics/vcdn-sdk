/**
 * HLS + TS validator.
 *
 * Performs lightweight streaming validation of TS segment integrity,
 * segment sizes, and manifest consistency without loading full files into memory.
 */

import { open, stat } from "node:fs/promises";
import path from "node:path";

import { parseAndValidateManifest } from "./manifest.js";
import type {
  ManifestSegmentInfo,
  SegmentValidation,
  ValidationResult,
} from "./types.js";

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
/** Number of packets to check for sync alignment. */
const SYNC_CHECK_PACKETS = 4;
/** Bytes to read for sync validation: 4 packets. */
const SYNC_CHECK_BYTES = TS_PACKET_SIZE * SYNC_CHECK_PACKETS;

/**
 * Validate TS segment integrity by reading only the first few packets.
 * Checks sync byte alignment without loading the entire file.
 */
async function validateSegmentIntegrity(
  absPath: string,
  sizeBytes: number,
): Promise<{ syncAligned: boolean; packetAligned: boolean }> {
  const packetAligned = sizeBytes % TS_PACKET_SIZE === 0;

  // Read first N packets to check sync byte alignment
  const fd = await open(absPath, "r");
  try {
    const readSize = Math.min(SYNC_CHECK_BYTES, sizeBytes);
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await fd.read(buf, 0, readSize, 0);

    if (bytesRead === 0) {
      return { syncAligned: false, packetAligned };
    }

    // Check sync byte at offset 0
    if (buf[0] !== TS_SYNC_BYTE) {
      return { syncAligned: false, packetAligned };
    }

    // Check sync byte at every 188-byte boundary within what we read
    let syncAligned = true;
    const packetsToCheck = Math.min(
      SYNC_CHECK_PACKETS,
      Math.floor(bytesRead / TS_PACKET_SIZE),
    );
    for (let i = 1; i < packetsToCheck; i++) {
      if (buf[i * TS_PACKET_SIZE] !== TS_SYNC_BYTE) {
        syncAligned = false;
        break;
      }
    }

    return { syncAligned, packetAligned };
  } finally {
    await fd.close();
  }
}

export interface ValidateHLSOptions {
  /** Max segment size in MB. Default: 5. */
  maxSegmentSizeMB?: number;
}

/**
 * Validate an HLS playlist and its TS segments.
 *
 * Performs:
 * - Manifest structure validation (via parseAndValidateManifest)
 * - TS sync byte alignment (streaming, first 4 packets only)
 * - Packet alignment (file size % 188 === 0)
 * - Segment size threshold check
 * - Safari risk heuristic assessment
 *
 * @param playlistPath - Absolute path to the .m3u8 file.
 * @param rootDir - Root directory for segment resolution.
 * @param options - Validation options.
 */
export async function validateHLS(
  playlistPath: string,
  rootDir: string,
  options?: ValidateHLSOptions,
): Promise<ValidationResult> {
  const maxSegmentSizeBytes = (options?.maxSegmentSizeMB ?? 5) * 1024 * 1024;

  const errors: string[] = [];
  const warnings: string[] = [];
  const segmentValidations: SegmentValidation[] = [];

  // 1. Parse and validate manifest structure
  const manifestResult = await parseAndValidateManifest(playlistPath, rootDir);
  errors.push(...manifestResult.errors);
  warnings.push(...manifestResult.warnings);

  if (manifestResult.segments.length === 0) {
    return {
      valid: errors.length === 0,
      safariRisk: false,
      oversizedSegments: false,
      needsNormalize: errors.length > 0,
      errors,
      warnings,
      segments: [],
    };
  }

  // 2. Validate each segment
  let hasOversized = false;
  let hasSyncIssue = false;
  let hasPacketIssue = false;
  const durations: number[] = [];

  for (const seg of manifestResult.segments) {
    let sizeBytes: number;
    try {
      const st = await stat(seg.absPath);
      sizeBytes = st.size;
    } catch {
      // Already reported in manifest validation
      continue;
    }

    const oversized = sizeBytes > maxSegmentSizeBytes;
    if (oversized) hasOversized = true;

    const { syncAligned, packetAligned } = await validateSegmentIntegrity(
      seg.absPath,
      sizeBytes,
    );

    if (!syncAligned) {
      hasSyncIssue = true;
      errors.push(`Segment ${seg.uri}: sync byte (0x47) misalignment`);
    }

    if (!packetAligned) {
      hasPacketIssue = true;
      warnings.push(
        `Segment ${seg.uri}: file size (${sizeBytes}) not divisible by 188`,
      );
    }

    if (oversized) {
      warnings.push(
        `Segment ${seg.uri}: size ${(sizeBytes / (1024 * 1024)).toFixed(2)}MB exceeds ${options?.maxSegmentSizeMB ?? 5}MB limit`,
      );
    }

    durations.push(seg.duration);

    segmentValidations.push({
      filename: seg.uri,
      sizeBytes,
      syncAligned,
      packetAligned,
      oversized,
    });
  }

  // 3. Safari risk heuristics
  let safariRisk = false;

  // Sync misalignment is a hard Safari risk
  if (hasSyncIssue) safariRisk = true;

  // Packet misalignment is a moderate Safari risk
  if (hasPacketIssue) safariRisk = true;

  // Inconsistent segment durations (>2x variance from mean)
  if (durations.length > 1) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxVariance = mean * 2;
    const hasHighVariance = durations.some(
      (d) => d > maxVariance || d < mean * 0.25,
    );
    if (hasHighVariance) {
      safariRisk = true;
      warnings.push("Inconsistent segment durations detected (Safari risk)");
    }
  }

  // 4. Determine if normalization is needed
  const needsNormalize =
    hasSyncIssue || hasPacketIssue || hasOversized || errors.length > 0;

  return {
    valid: errors.length === 0,
    safariRisk,
    oversizedSegments: hasOversized,
    needsNormalize,
    errors,
    warnings,
    segments: segmentValidations,
  };
}
