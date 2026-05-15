import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { parseAndValidateManifest } from "../normalize/manifest.js";

const TEST_DIR = path.join(tmpdir(), "vcdn-test-manifest-" + Date.now());

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("parseAndValidateManifest", () => {
  it("should parse a valid playlist with correct segment info", async () => {
    const dir = path.join(TEST_DIR, "valid");
    await mkdir(dir, { recursive: true });

    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXTINF:5.005,
seg0000.ts
#EXTINF:4.838,
seg0001.ts
#EXTINF:3.003,
seg0002.ts
#EXT-X-ENDLIST
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);
    await writeFile(path.join(dir, "seg0000.ts"), Buffer.alloc(188));
    await writeFile(path.join(dir, "seg0001.ts"), Buffer.alloc(188));
    await writeFile(path.join(dir, "seg0002.ts"), Buffer.alloc(188));

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.segments).toHaveLength(3);
    expect(result.targetDuration).toBe(6);

    // Check sequence numbers (media sequence 5 + index)
    expect(result.segments[0]!.sequence).toBe(5);
    expect(result.segments[1]!.sequence).toBe(6);
    expect(result.segments[2]!.sequence).toBe(7);

    // Check durations
    expect(result.segments[0]!.duration).toBeCloseTo(5.005);
    expect(result.segments[1]!.duration).toBeCloseTo(4.838);
    expect(result.segments[2]!.duration).toBeCloseTo(3.003);
  });

  it("should report error for empty playlist", async () => {
    const dir = path.join(TEST_DIR, "empty");
    await mkdir(dir, { recursive: true });

    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-ENDLIST
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    expect(result.errors.some((e) => e.includes("no segments"))).toBe(true);
    expect(result.segments).toHaveLength(0);
  });

  it("should report error for master playlist", async () => {
    const dir = path.join(TEST_DIR, "master");
    await mkdir(dir, { recursive: true });

    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
mid.m3u8
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    expect(result.errors.some((e) => e.includes("Master playlist"))).toBe(true);
  });

  it("should report error when parser produces no segments (invalid EXTINF)", async () => {
    const dir = path.join(TEST_DIR, "bad-extinf");
    await mkdir(dir, { recursive: true });

    // Note: m3u8-parser silently coerces invalid durations (e.g. -5 becomes targetDuration).
    // An empty URI line causes the parser to produce zero segments.
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,

#EXT-X-ENDLIST
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    // Parser drops segments with empty URIs → "no segments" error
    expect(result.errors.some((e) => e.includes("no segments"))).toBe(true);
  });

  it("should report error for missing segment files", async () => {
    const dir = path.join(TEST_DIR, "missing");
    await mkdir(dir, { recursive: true });

    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,
seg0000.ts
#EXTINF:5.0,
nonexistent.ts
#EXT-X-ENDLIST
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);
    await writeFile(path.join(dir, "seg0000.ts"), Buffer.alloc(188));

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    expect(result.errors.some((e) => e.includes("file not found"))).toBe(true);
    expect(result.segments).toHaveLength(1); // Only the valid one
  });

  it("should warn when segment duration exceeds 1.5x target", async () => {
    const dir = path.join(TEST_DIR, "long-duration");
    await mkdir(dir, { recursive: true });

    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg0000.ts
#EXTINF:10.0,
seg0001.ts
#EXT-X-ENDLIST
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);
    await writeFile(path.join(dir, "seg0000.ts"), Buffer.alloc(188));
    await writeFile(path.join(dir, "seg0001.ts"), Buffer.alloc(188));

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    expect(result.warnings.some((w) => w.includes("exceeds 1.5x target"))).toBe(true);
  });

  it("should warn about missing target duration", async () => {
    const dir = path.join(TEST_DIR, "no-target");
    await mkdir(dir, { recursive: true });

    // Playlist without EXT-X-TARGETDURATION
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:5.0,
seg0000.ts
#EXT-X-ENDLIST
`;
    await writeFile(path.join(dir, "playlist.m3u8"), playlist);
    await writeFile(path.join(dir, "seg0000.ts"), Buffer.alloc(188));

    const result = await parseAndValidateManifest(
      path.join(dir, "playlist.m3u8"),
      dir,
    );

    expect(result.warnings.some((w) => w.includes("TARGETDURATION"))).toBe(true);
  });
});
