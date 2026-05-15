/**
 * FFmpeg/FFprobe process orchestration.
 *
 * Spawns ffmpeg/ffprobe as child processes with:
 * - Structured progress parsing from stderr
 * - Timeout handling (SIGTERM → grace period → SIGKILL)
 * - AbortSignal support
 * - Auto-detection of binaries in PATH
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import type { FfmpegRunOptions } from "./types.js";

/** Grace period after SIGTERM before SIGKILL (ms). */
const KILL_GRACE_MS = 5_000;

/**
 * Attempt to find a binary in PATH.
 * Returns the resolved path or null if not found.
 */
async function findInPath(binary: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(separator).filter(Boolean);

  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not found in this dir, continue
    }
  }
  return null;
}

/**
 * Detect ffmpeg binary path.
 * Uses custom path if provided, otherwise searches PATH.
 *
 * @throws Error if ffmpeg is not found.
 */
export async function detectFfmpeg(customPath?: string): Promise<string> {
  if (customPath) {
    try {
      await access(customPath, constants.X_OK);
      return customPath;
    } catch {
      throw new Error(
        `ffmpeg not found at custom path: ${customPath}. Ensure the file exists and is executable.`,
      );
    }
  }

  const found = await findInPath("ffmpeg");
  if (found) return found;

  throw new Error(
    "ffmpeg not found in PATH. Install ffmpeg or provide the ffmpegPath option.",
  );
}

/**
 * Detect ffprobe binary path.
 * Uses custom path if provided, otherwise searches PATH.
 *
 * @throws Error if ffprobe is not found.
 */
export async function detectFfprobe(customPath?: string): Promise<string> {
  if (customPath) {
    try {
      await access(customPath, constants.X_OK);
      return customPath;
    } catch {
      throw new Error(
        `ffprobe not found at custom path: ${customPath}. Ensure the file exists and is executable.`,
      );
    }
  }

  const found = await findInPath("ffprobe");
  if (found) return found;

  throw new Error(
    "ffprobe not found in PATH. Install ffprobe (usually bundled with ffmpeg) or provide the ffprobePath option.",
  );
}

/**
 * Parse ffmpeg progress output from stderr.
 * Looks for `time=HH:MM:SS.ms` pattern and converts to seconds.
 */
function parseTimeFromStderr(line: string): number | null {
  // Match time=00:01:23.45 or time=83.45
  const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (match) {
    const hours = parseInt(match[1]!, 10);
    const minutes = parseInt(match[2]!, 10);
    const seconds = parseFloat(match[3]!);
    return hours * 3600 + minutes * 60 + seconds;
  }

  // Simpler format: time=123.45
  const simpleMatch = line.match(/time=(\d+(?:\.\d+)?)\s/);
  if (simpleMatch) {
    return parseFloat(simpleMatch[1]!);
  }

  return null;
}

/**
 * Run an ffmpeg command with progress reporting, timeout, and abort support.
 *
 * @throws Error on non-zero exit, timeout, or abort.
 */
export async function runFfmpeg(options: FfmpegRunOptions): Promise<string> {
  const {
    args,
    ffmpegPath,
    timeoutMs = 300_000,
    signal,
    onProgress,
    durationSec,
  } = options;

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const proc: ChildProcess = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let killed = false;
    let stderrBuf = "";
    let stdoutBuf = "";
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      signal?.removeEventListener("abort", onAbort);
    };

    const killProc = (reason: string) => {
      if (killed) return;
      killed = true;
      proc.kill("SIGTERM");
      killHandle = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
      }, KILL_GRACE_MS);
    };

    const onAbort = () => {
      killProc("aborted");
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    // Timeout
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        killProc("timeout");
        cleanup();
        reject(
          new Error(
            `ffmpeg timed out after ${timeoutMs}ms. stderr: ${stderrBuf.slice(-500)}`,
          ),
        );
      }, timeoutMs);
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;

      // Parse progress if we have duration info
      if (onProgress && durationSec && durationSec > 0) {
        const timeSec = parseTimeFromStderr(text);
        if (timeSec !== null) {
          const pct = Math.min(100, Math.round((timeSec / durationSec) * 100));
          onProgress(pct);
        }
      }
    });

    proc.on("error", (err) => {
      cleanup();
      reject(
        new Error(`ffmpeg spawn error: ${err.message}. Is ffmpeg installed at ${ffmpegPath}?`),
      );
    });

    proc.on("close", (code) => {
      cleanup();
      if (killed) return; // Already rejected

      if (code === 0) {
        resolve(stdoutBuf);
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}. stderr:\n${stderrBuf.slice(-2000)}`,
          ),
        );
      }
    });

    // Close stdin immediately (we don't pipe input)
    proc.stdin?.end();
  });
}

/**
 * Run ffprobe and return parsed JSON output.
 */
export async function runFfprobe(options: {
  args: string[];
  ffprobePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { args, ffprobePath, timeoutMs = 60_000, signal } = options;

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const proc = spawn(ffprobePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let killed = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
      }
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (!killed) {
          killed = true;
          proc.kill("SIGTERM");
        }
        cleanup();
        reject(new Error(`ffprobe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on("error", (err) => {
      cleanup();
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });

    proc.on("close", (code) => {
      cleanup();
      if (killed) return;

      if (code === 0) {
        resolve(stdoutBuf);
      } else {
        reject(
          new Error(
            `ffprobe exited with code ${code}. stderr:\n${stderrBuf.slice(-1000)}`,
          ),
        );
      }
    });

    proc.stdin?.end();
  });
}
