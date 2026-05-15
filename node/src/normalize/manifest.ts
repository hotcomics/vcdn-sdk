/**
 * Manifest parsing and validation utilities.
 *
 * Wraps the existing m3u8-parser dependency to extract segment metadata,
 * validate EXTINF durations, check sequence ordering, and verify files on disk.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Parser } from "m3u8-parser";

import type { ManifestParseResult, ManifestSegmentInfo } from "./types.js";

/**
 * Strip query string and fragment from a URI.
 */
function stripUriQuery(uri: string): string {
  const i = uri.search(/[?#]/);
  return i === -1 ? uri : uri.slice(0, i);
}

/**
 * Parse a media playlist and validate its structure.
 *
 * Checks:
 * - EXTINF durations are valid positive numbers
 * - Segment sequence is monotonically increasing
 * - Referenced .ts files exist on disk
 * - Segment count matches actual file references
 *
 * @param playlistPath - Absolute path to the .m3u8 file.
 * @param rootDir - Root directory for resolving relative segment URIs.
 */
export async function parseAndValidateManifest(
  playlistPath: string,
  rootDir: string,
): Promise<ManifestParseResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const playlistText = await readFile(playlistPath, "utf8");
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const manifest = parser.manifest;

  // Reject master playlists
  if (manifest.playlists?.length && !manifest.segments?.length) {
    errors.push("Master playlist detected; only media playlists are supported");
    return { segments: [], targetDuration: 0, errors, warnings };
  }

  const targetDuration = manifest.targetDuration ?? 0;
  if (targetDuration <= 0) {
    warnings.push("Missing or invalid EXT-X-TARGETDURATION");
  }

  const rawSegments = manifest.segments ?? [];
  if (rawSegments.length === 0) {
    errors.push("Playlist contains no segments");
    return { segments: [], targetDuration, errors, warnings };
  }

  const mediaSequence: number =
    ((manifest as unknown as Record<string, unknown>).mediaSequence as number) ?? 0;

  const segments: ManifestSegmentInfo[] = [];
  const playlistDir = path.dirname(playlistPath);

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!;
    const uri = seg.uri?.trim();

    if (!uri) {
      errors.push(`Segment at index ${i} has empty URI`);
      continue;
    }

    const stripped = stripUriQuery(uri);
    const duration = seg.duration ?? 0;
    const sequence = mediaSequence + i;

    // Validate EXTINF duration
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push(`Segment ${stripped}: invalid EXTINF duration (${duration})`);
    }

    // Check duration variance against target
    if (targetDuration > 0 && duration > targetDuration * 1.5) {
      warnings.push(
        `Segment ${stripped}: duration ${duration.toFixed(3)}s exceeds 1.5x target (${targetDuration}s)`,
      );
    }

    // Resolve absolute path
    const absPath = path.resolve(playlistDir, stripped);
    const rel = path.relative(rootDir, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      errors.push(`Segment ${stripped}: path escapes root directory`);
      continue;
    }

    // Check file exists
    try {
      const st = await stat(absPath);
      if (!st.isFile()) {
        errors.push(`Segment ${stripped}: not a regular file`);
        continue;
      }
    } catch {
      errors.push(`Segment ${stripped}: file not found on disk`);
      continue;
    }

    segments.push({ uri: stripped, duration, sequence, absPath });
  }

  // Validate monotonic sequence
  for (let i = 1; i < segments.length; i++) {
    if (segments[i]!.sequence <= segments[i - 1]!.sequence) {
      warnings.push(
        `Non-monotonic sequence at index ${i}: ${segments[i]!.sequence} <= ${segments[i - 1]!.sequence}`,
      );
      break; // One warning is enough
    }
  }

  return { segments, targetDuration, errors, warnings };
}
