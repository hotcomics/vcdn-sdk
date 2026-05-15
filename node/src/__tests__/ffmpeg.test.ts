import { describe, it, expect } from "vitest";

import { detectFfmpeg, detectFfprobe, runFfmpeg } from "../normalize/ffmpeg.js";

describe("ffmpeg detection", () => {
  it("should detect ffmpeg in PATH (if installed)", async () => {
    try {
      const ffmpegPath = await detectFfmpeg();
      expect(ffmpegPath).toBeTruthy();
      expect(typeof ffmpegPath).toBe("string");
    } catch (err) {
      // Skip if ffmpeg not installed
      expect((err as Error).message).toContain("not found");
    }
  });

  it("should detect ffprobe in PATH (if installed)", async () => {
    try {
      const ffprobePath = await detectFfprobe();
      expect(ffprobePath).toBeTruthy();
      expect(typeof ffprobePath).toBe("string");
    } catch (err) {
      expect((err as Error).message).toContain("not found");
    }
  });

  it("should throw for invalid custom ffmpeg path", async () => {
    await expect(
      detectFfmpeg("/nonexistent/path/to/ffmpeg"),
    ).rejects.toThrow("not found at custom path");
  });

  it("should throw for invalid custom ffprobe path", async () => {
    await expect(
      detectFfprobe("/nonexistent/path/to/ffprobe"),
    ).rejects.toThrow("not found at custom path");
  });
});

describe("runFfmpeg", () => {
  it("should run ffmpeg -version successfully (if installed)", async () => {
    let ffmpegPath: string;
    try {
      ffmpegPath = await detectFfmpeg();
    } catch {
      // Skip test if ffmpeg not available
      return;
    }

    const output = await runFfmpeg({
      args: ["-version"],
      ffmpegPath,
      timeoutMs: 10_000,
    });

    expect(output).toContain("ffmpeg version");
  });

  it("should reject on non-zero exit code", async () => {
    let ffmpegPath: string;
    try {
      ffmpegPath = await detectFfmpeg();
    } catch {
      return;
    }

    await expect(
      runFfmpeg({
        args: ["-i", "/nonexistent/file.mp4"],
        ffmpegPath,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("exited with code");
  });

  it("should respect timeout", async () => {
    let ffmpegPath: string;
    try {
      ffmpegPath = await detectFfmpeg();
    } catch {
      return;
    }

    // Use a very short timeout with a command that would take longer
    await expect(
      runFfmpeg({
        args: [
          "-f", "lavfi",
          "-i", "testsrc=duration=60:size=320x240:rate=30",
          "-f", "null",
          "-",
        ],
        ffmpegPath,
        timeoutMs: 100, // Very short timeout
      }),
    ).rejects.toThrow("timed out");
  });

  it("should respect abort signal", async () => {
    let ffmpegPath: string;
    try {
      ffmpegPath = await detectFfmpeg();
    } catch {
      return;
    }

    const ac = new AbortController();
    // Abort immediately
    ac.abort();

    await expect(
      runFfmpeg({
        args: ["-version"],
        ffmpegPath,
        signal: ac.signal,
      }),
    ).rejects.toThrow("Aborted");
  });
});
