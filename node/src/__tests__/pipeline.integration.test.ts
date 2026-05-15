/**
 * Integration test for the full normalize pipeline.
 *
 * Requires ffmpeg to be installed in PATH.
 * These tests create real TS fixtures and run the full normalize flow.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { detectFfmpeg } from "../normalize/ffmpeg.js";
import { normalizeHLS, calculateHlsTime } from "../normalize/remux.js";
import { validateHLS } from "../normalize/validate.js";
import { TempWorkspace } from "../normalize/temp.js";
import type { NormalizeProgressEvent } from "../normalize/types.js";

const TEST_DIR = path.join(tmpdir(), "vcdn-test-pipeline-" + Date.now());
let ffmpegPath: string | null = null;

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });

  try {
    ffmpegPath = await detectFfmpeg();
  } catch {
    ffmpegPath = null;
  }
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/**
 * Generate a minimal valid HLS directory using ffmpeg.
 * Creates a short test video and segments it.
 */
async function generateTestHLS(outputDir: string): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg not available");

  await mkdir(outputDir, { recursive: true });

  const playlistPath = path.join(outputDir, "index.m3u8");

  // Generate a 3-second test video and segment it
  execSync(
    `"${ffmpegPath}" -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=25" ` +
    `-f lavfi -i "sine=frequency=440:duration=3" ` +
    `-c:v libx264 -preset ultrafast -c:a aac -b:a 64k ` +
    `-f hls -hls_time 1 -hls_playlist_type vod ` +
    `-hls_segment_filename "${path.join(outputDir, "seg%04d.ts")}" ` +
    `"${playlistPath}"`,
    { stdio: "pipe", timeout: 30_000 },
  );

  return playlistPath;
}

describe("Full Normalize Pipeline (integration)", () => {
  it("should validate a clean HLS directory as valid", async () => {
    if (!ffmpegPath) return; // Skip if no ffmpeg

    const hlsDir = path.join(TEST_DIR, "clean-hls");
    const playlistPath = await generateTestHLS(hlsDir);

    const result = await validateHLS(playlistPath, hlsDir, {
      maxSegmentSizeMB: 5,
    });

    expect(result.valid).toBe(true);
    expect(result.needsNormalize).toBe(false);
    expect(result.segments.length).toBeGreaterThan(0);

    for (const seg of result.segments) {
      expect(seg.syncAligned).toBe(true);
      expect(seg.packetAligned).toBe(true);
      expect(seg.oversized).toBe(false);
    }
  });

  it("should normalize HLS and produce valid output", async () => {
    if (!ffmpegPath) return;

    const hlsDir = path.join(TEST_DIR, "normalize-input");
    const playlistPath = await generateTestHLS(hlsDir);

    const workspace = await TempWorkspace.create({ root: TEST_DIR });
    const events: NormalizeProgressEvent[] = [];

    try {
      const result = await normalizeHLS({
        inputPlaylistPath: playlistPath,
        outputDir: workspace.dir,
        maxSegmentSizeMB: 5,
        ffmpegPath: ffmpegPath!,
        timeoutMs: 30_000,
        probedBitrate: 500_000, // ~500kbps test video
        onProgress: (evt) => events.push(evt),
      });

      // Should produce output
      expect(result.playlistPath).toBeTruthy();
      expect(result.segmentPaths.length).toBeGreaterThan(0);

      // Output playlist should exist and be valid m3u8
      const playlistContent = await readFile(result.playlistPath, "utf8");
      expect(playlistContent).toContain("#EXTM3U");
      expect(playlistContent).toContain("#EXT-X-ENDLIST");

      // All output segments should exist
      for (const segPath of result.segmentPaths) {
        const st = await stat(segPath);
        expect(st.isFile()).toBe(true);
        expect(st.size).toBeGreaterThan(0);
      }

      // Should have emitted progress events
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.phase === "normalizing")).toBe(true);
      expect(events.some((e) => e.phase === "regenerating")).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });

  it("should produce segments under maxSegmentSizeMB", async () => {
    if (!ffmpegPath) return;

    const hlsDir = path.join(TEST_DIR, "size-check");
    const playlistPath = await generateTestHLS(hlsDir);

    const workspace = await TempWorkspace.create({ root: TEST_DIR });
    const maxMB = 1; // 1MB limit

    try {
      const result = await normalizeHLS({
        inputPlaylistPath: playlistPath,
        outputDir: workspace.dir,
        maxSegmentSizeMB: maxMB,
        ffmpegPath: ffmpegPath!,
        timeoutMs: 30_000,
        probedBitrate: 500_000,
      });

      const maxBytes = maxMB * 1024 * 1024;
      for (const segPath of result.segmentPaths) {
        const st = await stat(segPath);
        // With a 500kbps test video and 1MB limit, segments should be well under
        expect(st.size).toBeLessThan(maxBytes);
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it("should validate normalized output as clean", async () => {
    if (!ffmpegPath) return;

    const hlsDir = path.join(TEST_DIR, "validate-output");
    const playlistPath = await generateTestHLS(hlsDir);

    const workspace = await TempWorkspace.create({ root: TEST_DIR });

    try {
      const normalized = await normalizeHLS({
        inputPlaylistPath: playlistPath,
        outputDir: workspace.dir,
        maxSegmentSizeMB: 5,
        ffmpegPath: ffmpegPath!,
        timeoutMs: 30_000,
        probedBitrate: 500_000,
      });

      // Validate the normalized output
      const validation = await validateHLS(
        normalized.playlistPath,
        workspace.dir,
        { maxSegmentSizeMB: 5 },
      );

      expect(validation.valid).toBe(true);
      expect(validation.safariRisk).toBe(false);
      expect(validation.needsNormalize).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });
});
