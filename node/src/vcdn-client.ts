import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  isAxiosError,
} from "axios";
import fg from "fast-glob";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pLimit from "p-limit";
import { Parser } from "m3u8-parser";

import { detectFfmpeg } from "./normalize/ffmpeg.js";
import { normalizeHLS } from "./normalize/remux.js";
import { probeHLS } from "./normalize/probe.js";
import { TempWorkspace } from "./normalize/temp.js";
import { validateHLS } from "./normalize/validate.js";
import type {
  NormalizeMode,
  NormalizeProgressEvent,
  ValidationResult,
} from "./normalize/types.js";

const API_VIDEOS = "/api/v1/videos";

export interface VcdnClientOptions {
  apiKey: string;
  /** Origin only, e.g. `https://upload.example.com` (no trailing `/api/v1`). */
  baseURL?: string;
  /** Alias of `baseURL` (matches existing SDK naming). */
  baseUrl?: string;
  /** When true, logs skipped segments and each successful PUT. */
  debug?: boolean;
}

export interface UploadHLSOptions {
  path: string;
  /** Display title for the created video. Defaults to `HLS SDK Upload` when omitted. */
  title?: string;
  /** Parallel segment uploads (clamped to 5–10). Default 8. */
  concurrency?: number;
  /**
   * Progress callback. Receives either:
   * - A number (0–100) for backward-compatible upload percent.
   * - A NormalizeProgressEvent object when normalize pipeline is active.
   */
  onProgress?: (event: NormalizeProgressEvent | number) => void;
  signal?: AbortSignal;
  /** Max time to wait for `ready` after complete. Default 15 minutes. */
  waitTimeoutMs?: number;
  /** Polling interval for `waitUntilReady`. Default 2000 ms. */
  pollIntervalMs?: number;
  /** When true, returns `bytesUploaded` / `segmentUploadMs` in the result. */
  metrics?: boolean;
  /** When true, sends `X-Segment-Sha256` per segment (hex). Server may ignore. */
  checksum?: boolean;

  // ─── Normalize Pipeline Options ─────────────────────────────────────────

  /**
   * Controls HLS validation and normalization before upload.
   * - `false`   — Upload raw without validation.
   * - `'auto'`  — Validate; normalize only if needed (DEFAULT).
   * - `'force'` — Always normalize before upload.
   * - `'strict'`— Validate only; reject if unsafe.
   */
  normalize?: NormalizeMode;
  /** Max segment size in MB. Segments exceeding this trigger normalization. Default: 5. */
  maxSegmentSizeMB?: number;
  /** Custom ffmpeg binary path. Auto-detected from PATH if omitted. */
  ffmpegPath?: string;
  /** Custom ffprobe binary path. Auto-detected from PATH if omitted. */
  ffprobePath?: string;
  /** Temp directory root for normalize intermediates. Default: os.tmpdir(). */
  tempDir?: string;
  /** Timeout for individual ffmpeg operations in ms. Default: 300000 (5 min). */
  ffmpegTimeoutMs?: number;
}

export interface UploadHLSResult {
  video_id: string;
  status: "ready";
  upload_id: string;
  /** True when playback is available (at least one source works). */
  playbackReady: boolean;
  /** Replication health: "healthy" | "partial" | "origin_only" | "degraded" | "pending". */
  replicationHealth?: string;
  /** Count of usable playback sources. */
  healthyReplicas?: number;
  /** Total published playback sources. */
  totalReplicas?: number;
  /** True when MinIO origin is among playback sources. */
  originFallbackActive?: boolean;
  /** Bytes uploaded for TS segments only (excludes skipped). */
  bytesUploaded?: number;
  /** Wall-clock ms spent in TS segment PUT requests (per attempt, summed). */
  segmentUploadMs?: number;
  /** True if the upload was normalized before upload. */
  normalized?: boolean;
  /** Validation result (present when normalize !== false). */
  validation?: ValidationResult;
}

export interface WaitUntilReadyOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class VcdnHlsError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "VcdnHlsError";
    this.code = code;
    this.detail = detail;
  }
}

function trimOrigin(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Mirrors upload-service `sanitizeSegmentName`. */
export function sanitizeSegmentName(input: string): string {
  let s = input.trim();
  s = path.posix.normalize("/" + s).replace(/^\//, "");
  if (!s || s === "." || s.includes("..")) return "";
  return s.replace(/\\/g, "/");
}

function stripUriQuery(uri: string): string {
  const i = uri.search(/[?#]/);
  return i === -1 ? uri : uri.slice(0, i);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableAxios(err: unknown): boolean {
  if (err instanceof VcdnHlsError) return false;
  if (!isAxiosError(err)) {
    return true;
  }
  const st = err.response?.status;
  if (st == null) return true;
  if (st === 429 || st === 408) return true;
  return st >= 500;
}

function httpVcdnError(ctx: string, res: AxiosResponse): VcdnHlsError {
  const body = res.data;
  const msg =
    typeof body === "object" && body && "message" in body
      ? String((body as { message?: string }).message)
      : res.statusText;
  return new VcdnHlsError("HTTP_ERROR", `${ctx}: HTTP ${res.status} ${msg}`.trim(), body);
}

function throwAxiosBadResponse(res: AxiosResponse, ctx: string): never {
  const err = httpVcdnError(ctx, res);
  throw new AxiosError(err.message, "ERR_BAD_RESPONSE", res.config, undefined, res);
}

function mapAxiosError(err: unknown, context: string): Error {
  if (err instanceof VcdnHlsError) return err;
  if (isAxiosError(err)) {
    const st = err.response?.status;
    const body = err.response?.data;
    const msg =
      typeof body === "object" && body && "message" in body
        ? String((body as { message?: string }).message)
        : err.message;
    return new VcdnHlsError(
      "HTTP_ERROR",
      `${context}: HTTP ${st ?? "?"} ${msg}`.trim(),
      body,
    );
  }
  if (err instanceof Error) {
    return new VcdnHlsError("REQUEST_FAILED", `${context}: ${err.message}`, err);
  }
  return new VcdnHlsError("REQUEST_FAILED", `${context}: unknown error`, err);
}

async function withRetries<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  debug: boolean,
  label: string,
): Promise<T> {
  const maxRetries = 3;
  let last: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === maxRetries || !isRetryableAxios(e)) {
        throw mapAxiosError(e, label);
      }
      const backoffMs = 500 * (attempt + 1) ** 2;
      if (debug) {
        console.debug(`[vcdn] ${label} retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms`);
      }
      await sleep(backoffMs, signal);
    }
  }
  throw mapAxiosError(last, label);
}

interface InitHlsUploadRequest {
  title?: string;
}

interface InitHlsResponse {
  video_id: string;
  upload_id: string;
  status?: string;
}

interface VideoRow {
  id: string;
  status: string;
  playback_ready?: boolean;
  replication_health?: string;
  healthy_replicas?: number;
  total_replicas?: number;
  origin_fallback_active?: boolean;
  error?: string | null;
}

interface UploadManifestSegment {
  filename: string;
  size?: number;
  etag?: string;
}

interface UploadManifestResponse {
  video_id: string;
  upload_id?: string;
  status?: string;
  uploaded?: UploadManifestSegment[];
  uploaded_count?: number;
  uploaded_bytes?: number;
  playlist_uploaded?: boolean;
}

async function sha256FileHex(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absPath), hash);
  return hash.digest("hex");
}

export class VcdnClient {
  private readonly axios: AxiosInstance;
  private readonly debug: boolean;

  constructor(opts: VcdnClientOptions) {
    const origin = trimOrigin(opts.baseURL ?? opts.baseUrl ?? "");
    if (!origin) {
      throw new VcdnHlsError("CONFIG", "baseURL (or baseUrl) is required");
    }
    if (!opts.apiKey?.trim()) {
      throw new VcdnHlsError("CONFIG", "apiKey is required");
    }
    this.debug = Boolean(opts.debug);
    this.axios = axios.create({
      baseURL: origin,
      headers: {
        Accept: "application/json",
        "X-API-Key": opts.apiKey.trim(),
      },
      validateStatus: () => true,
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
    });
  }

  async waitUntilReady(
    videoId: string,
    opts?: WaitUntilReadyOptions,
  ): Promise<VideoRow> {
    const signal = opts?.signal;
    const timeoutMs = opts?.timeoutMs ?? 900_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 2000;
    const started = Date.now();

    for (;;) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (Date.now() - started > timeoutMs) {
        throw new VcdnHlsError(
          "WAIT_TIMEOUT",
          `Timed out waiting for video ${videoId} to become ready (${timeoutMs}ms)`,
        );
      }
      const res = await this.axios.get<VideoRow>(
        `${API_VIDEOS}/${encodeURIComponent(videoId)}`,
        { signal },
      );
      if (res.status !== 200) {
        throw httpVcdnError("GET video", res);
      }
      const row = res.data;
      // Playback-ready architecture: stop polling when playback is available,
      // regardless of replication completeness. Falls back to status check
      // for backward compatibility with older backends.
      if (row.playback_ready === true || row.status === "ready") {
        return row;
      }
      if (row.status === "failed") {
        throw new VcdnHlsError(
          "VIDEO_FAILED",
          row.error?.trim() || `Video ${videoId} failed processing`,
          row,
        );
      }
      await sleep(pollIntervalMs, signal);
    }
  }

  async uploadHLS(options: UploadHLSOptions): Promise<UploadHLSResult> {
    const root = path.resolve(options.path);
    const signal = options.signal;
    const debug = this.debug;
    const normalizeMode: NormalizeMode = options.normalize ?? "auto";
    let rawConcurrency = options.concurrency ?? 8;
    if (rawConcurrency < 5) rawConcurrency = 5;
    if (rawConcurrency > 10) rawConcurrency = 10;
    const limit = pLimit(rawConcurrency);

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // ─── Discover playlist ────────────────────────────────────────────────
    const playlists = await fg("**/*.m3u8", {
      cwd: root,
      onlyFiles: true,
      absolute: true,
      unique: true,
    });
    if (playlists.length === 0) {
      throw new VcdnHlsError("NO_PLAYLIST", `No .m3u8 file found under ${root}`);
    }
    if (playlists.length !== 1) {
      throw new VcdnHlsError(
        "MULTIPLE_PLAYLISTS",
        `Expected exactly one .m3u8 under ${root}, found ${playlists.length}: ${playlists
          .map((p) => path.relative(root, p))
          .join(", ")}`,
      );
    }
    let playlistPath = playlists[0]!;
    let playlistDir = path.dirname(playlistPath);

    // ─── Normalize Pipeline ───────────────────────────────────────────────
    let validationResult: ValidationResult | undefined;
    let didNormalize = false;
    let workspace: TempWorkspace | undefined;

    if (normalizeMode !== false) {
      // Phase: validating
      this.emitNormalizeProgress(options, { phase: "validating", progress: 0 });

      validationResult = await validateHLS(playlistPath, root, {
        maxSegmentSizeMB: options.maxSegmentSizeMB ?? 5,
      });

      this.emitNormalizeProgress(options, { phase: "validating", progress: 10 });

      if (debug && validationResult.warnings.length > 0) {
        for (const w of validationResult.warnings) {
          console.debug(`[vcdn] validation warning: ${w}`);
        }
      }

      // Decide action based on mode
      if (normalizeMode === "strict") {
        if (!validationResult.valid) {
          throw new VcdnHlsError(
            "VALIDATION_FAILED",
            `HLS validation failed in strict mode: ${validationResult.errors.join("; ")}`,
            validationResult,
          );
        }
        // Strict mode passes — upload raw
      } else {
        // auto or force
        const shouldNormalize =
          normalizeMode === "force" || validationResult.needsNormalize;

        if (shouldNormalize) {
          // Check ffmpeg availability
          let ffmpegPath: string;
          try {
            ffmpegPath = await detectFfmpeg(options.ffmpegPath);
          } catch (err) {
            if (normalizeMode === "force") {
              throw new VcdnHlsError(
                "FFMPEG_NOT_FOUND",
                err instanceof Error ? err.message : "ffmpeg not found",
              );
            }
            // auto mode: graceful degradation — warn and upload raw
            if (debug) {
              console.debug(
                "[vcdn] normalization needed but ffmpeg not available; uploading raw",
              );
            }
            ffmpegPath = ""; // Will not be used
          }

          if (ffmpegPath) {
            // Phase: probing
            this.emitNormalizeProgress(options, { phase: "probing", progress: 12 });

            let probedBitrate = 0;
            try {
              const probeResult = await probeHLS(playlistPath, {
                ffprobePath: options.ffprobePath,
                timeoutMs: options.ffmpegTimeoutMs ?? 60_000,
                signal,
              });
              probedBitrate = probeResult.bitrateBps;

              if (debug) {
                console.debug(
                  `[vcdn] probe: bitrate=${probedBitrate}bps, duration=${probeResult.durationSec}s, codec=${probeResult.videoCodec}`,
                );
              }
            } catch (err) {
              if (debug) {
                console.debug(
                  `[vcdn] probe failed (non-fatal): ${err instanceof Error ? err.message : err}`,
                );
              }
              // Continue with unknown bitrate — will use default hls_time
            }

            this.emitNormalizeProgress(options, { phase: "probing", progress: 20 });

            // Phase: normalizing + regenerating
            workspace = await TempWorkspace.create({ root: options.tempDir });
            try {
              const normalized = await normalizeHLS({
                inputPlaylistPath: playlistPath,
                outputDir: workspace.dir,
                maxSegmentSizeMB: options.maxSegmentSizeMB ?? 5,
                ffmpegPath,
                timeoutMs: options.ffmpegTimeoutMs ?? 300_000,
                signal,
                onProgress: (evt) => this.emitNormalizeProgress(options, evt),
                probedBitrate,
              });

              // Switch to normalized output for upload
              playlistPath = normalized.playlistPath;
              playlistDir = path.dirname(playlistPath);
              didNormalize = true;

              if (debug) {
                console.debug(
                  `[vcdn] normalized: ${normalized.segmentPaths.length} segments in ${workspace.dir}`,
                );
              }
            } catch (err) {
              await workspace.cleanup();
              workspace = undefined;

              if (normalizeMode === "force") {
                throw new VcdnHlsError(
                  "NORMALIZE_FAILED",
                  `Normalization failed: ${err instanceof Error ? err.message : err}`,
                  err,
                );
              }
              // auto mode: fallback to raw upload
              if (debug) {
                console.debug(
                  `[vcdn] normalization failed (non-fatal in auto mode): ${err instanceof Error ? err.message : err}`,
                );
              }
            }
          }
        }
      }
    }

    // ─── Parse playlist for upload ────────────────────────────────────────
    try {
      const playlistText = await readFile(playlistPath, "utf8");

      const parser = new Parser();
      parser.push(playlistText);
      parser.end();
      const manifest = parser.manifest;

      if (manifest.playlists?.length && !manifest.segments?.length) {
        throw new VcdnHlsError(
          "MASTER_PLAYLIST",
          "Master HLS playlist is not supported; use a single media playlist directory.",
        );
      }

      const segmentsRaw = manifest.segments ?? [];
      const work: { objectName: string; absPath: string }[] = [];

      for (const seg of segmentsRaw) {
        const uri = seg.uri?.trim();
        if (!uri) continue;
        const stripped = stripUriQuery(uri);
        if (!stripped.toLowerCase().endsWith(".ts")) {
          if (debug) {
            console.debug(`[vcdn] skip non-TS segment URI: ${uri}`);
          }
          continue;
        }
        const objectName = sanitizeSegmentName(stripped);
        if (!objectName) {
          throw new VcdnHlsError("INVALID_SEGMENT_URI", `Invalid segment URI: ${uri}`);
        }
        if (objectName.includes("/")) {
          throw new VcdnHlsError(
            "NESTED_SEGMENT_PATH",
            `Segment URI must be a single path segment for this API: ${uri}`,
          );
        }
        const abs = path.resolve(playlistDir, stripped);
        const rel = path.relative(path.resolve(playlistDir), abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new VcdnHlsError("PATH_TRAVERSAL", `Segment path escapes playlist directory: ${uri}`);
        }
        const st = await stat(abs);
        if (!st.isFile()) {
          throw new VcdnHlsError("MISSING_SEGMENT", `Not a file: ${abs}`);
        }
        if (st.size <= 0) {
          throw new VcdnHlsError("EMPTY_SEGMENT", `Segment file is empty: ${abs}`);
        }
        work.push({ objectName, absPath: abs });
      }

      if (work.length === 0) {
        throw new VcdnHlsError("NO_TS_SEGMENTS", "Playlist contains no .ts segment URIs");
      }

      // ─── Upload phase ─────────────────────────────────────────────────
      this.emitNormalizeProgress(options, { phase: "uploading", progress: 50 });

      const initRes = await withRetries(
        async () => {
          const body: InitHlsUploadRequest = {};
          const title = options.title?.trim();
          if (title) {
            body.title = title;
          }
          const res = await this.axios.post<InitHlsResponse>(
            `${API_VIDEOS}/init-hls-upload`,
            body,
            { signal },
          );
          if (res.status !== 200) {
            throwAxiosBadResponse(res, "init-hls-upload");
          }
          return res.data;
        },
        signal,
        debug,
        "init-hls-upload",
      );

      const videoId = initRes.video_id;
      const uploadId = initRes.upload_id;

      const uploadedManifest = await this.fetchUploadManifest(videoId, signal, debug);
      const uploadedSet = new Set(uploadedManifest?.uploaded?.map((s) => sanitizeSegmentName(s.filename)).filter(Boolean));
      const useManifestSkips = uploadedManifest !== null;

      const total = work.length;
      let done = 0;
      const percentFor = (completed: number) =>
        total === 0 ? 100 : Math.min(100, Math.round((completed / total) * 100));
      const report = () => {
        const pct = percentFor(done);
        // Map upload progress to 50-95 range when normalize is active
        if (normalizeMode !== false) {
          const mapped = 50 + Math.round(pct * 0.45);
          this.emitNormalizeProgress(options, { phase: "uploading", progress: mapped });
        } else {
          options.onProgress?.(pct);
        }
      };
      report();

      let bytesUploaded = 0;
      let segmentUploadMs = 0;
      const wall0 = options.metrics ? Date.now() : 0;

      const runSegment = async (item: (typeof work)[0]) => {
        if (uploadedSet.has(item.objectName)) {
          const pct = percentFor(done + 1);
          if (debug) {
            console.debug(`[vcdn] skip (manifest exists) ${item.objectName} (${pct}%)`);
          }
          done++;
          report();
          return;
        }

        if (!useManifestSkips) {
          const headUrl = `${API_VIDEOS}/${encodeURIComponent(videoId)}/segments/${encodeURIComponent(
            item.objectName,
          )}`;
          const head = await this.axios.head(headUrl, { signal });
          if (head.status === 200) {
            const pct = percentFor(done + 1);
            if (debug) {
              console.debug(`[vcdn] skip (HEAD exists) ${item.objectName} (${pct}%)`);
            }
            done++;
            report();
            return;
          }
          if (head.status !== 404) {
            throw httpVcdnError(`HEAD segment ${item.objectName}`, head);
          }
        }

        const putUrl = `${API_VIDEOS}/${encodeURIComponent(videoId)}/segments/${encodeURIComponent(
          item.objectName,
        )}`;

        const st = await stat(item.absPath);
        const uploadStarted = options.metrics ? Date.now() : 0;
        const checksumHex = options.checksum ? await sha256FileHex(item.absPath) : null;

        await withRetries(
          async () => {
            const headers: Record<string, string> = {
              "Content-Type": "video/MP2T",
              "Content-Length": String(st.size),
            };
            if (checksumHex) {
              headers["X-Segment-Sha256"] = checksumHex;
            }
            const stream = createReadStream(item.absPath);
            const res = await this.axios.put(putUrl, stream, {
              headers,
              signal,
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
            });
            if (res.status !== 200) {
              throwAxiosBadResponse(res, `PUT segment ${item.objectName}`);
            }
            return res;
          },
          signal,
          debug,
          `PUT segment ${item.objectName}`,
        );

        if (options.metrics) {
          segmentUploadMs += Date.now() - uploadStarted;
          bytesUploaded += st.size;
        }

        const pct = percentFor(done + 1);
        if (debug) {
          console.debug(`[vcdn] uploaded ${item.objectName} (${st.size} bytes, ${pct}%)`);
        }
        done++;
        report();
      };

      await Promise.all(work.map((item) => limit(() => runSegment(item))));

      if (debug && options.metrics && bytesUploaded > 0) {
        const sec = (Date.now() - wall0) / 1000;
        const mbps = (bytesUploaded / (1024 * 1024)) / Math.max(sec, 1e-6);
        console.debug(
          `[vcdn] segment throughput ~${mbps.toFixed(2)} MiB/s wall (${percentFor(done)}%, ${bytesUploaded} bytes)`,
        );
      }

      const playlistUrl = `${API_VIDEOS}/${encodeURIComponent(videoId)}/playlist`;
      await withRetries(
        async () => {
          const plStream = createReadStream(playlistPath);
          const plStat = await stat(playlistPath);
          const res = await this.axios.put(playlistUrl, plStream, {
            headers: {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Content-Length": String(plStat.size),
            },
            signal,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          });
          if (res.status !== 200) {
            throwAxiosBadResponse(res, "PUT playlist");
          }
          return res;
        },
        signal,
        debug,
        "PUT playlist",
      );

      await withRetries(
        async () => {
          const res = await this.axios.post(
            `${API_VIDEOS}/${encodeURIComponent(videoId)}/complete`,
            {},
            { signal },
          );
          if (res.status !== 200) {
            throwAxiosBadResponse(res, "POST complete");
          }
          return res;
        },
        signal,
        debug,
        "POST complete",
      );

      const readyRow = await this.waitUntilReady(videoId, {
        signal,
        timeoutMs: options.waitTimeoutMs ?? 900_000,
        pollIntervalMs: options.pollIntervalMs ?? 2000,
      });

      const result: UploadHLSResult = {
        video_id: videoId,
        status: "ready",
        upload_id: uploadId,
        playbackReady: true,
        replicationHealth: readyRow.replication_health ?? "healthy",
        healthyReplicas: readyRow.healthy_replicas,
        totalReplicas: readyRow.total_replicas,
        originFallbackActive: readyRow.origin_fallback_active,
        normalized: didNormalize,
        validation: validationResult,
      };
      if (options.metrics) {
        result.bytesUploaded = bytesUploaded;
        result.segmentUploadMs = segmentUploadMs;
      }

      this.emitNormalizeProgress(options, { phase: "done", progress: 100 });
      return result;
    } finally {
      // ─── Cleanup ──────────────────────────────────────────────────────
      if (workspace) {
        this.emitNormalizeProgress(options, { phase: "cleaning", progress: 96 });
        await workspace.cleanup();
      }
    }
  }

  /**
   * Emit a normalize progress event through the onProgress callback.
   * When normalize is false, this is a no-op.
   */
  private emitNormalizeProgress(
    options: UploadHLSOptions,
    event: NormalizeProgressEvent,
  ): void {
    if (!options.onProgress) return;
    options.onProgress(event);
  }

  private async fetchUploadManifest(
    videoId: string,
    signal: AbortSignal | undefined,
    debug: boolean,
  ): Promise<UploadManifestResponse | null> {
    const url = `${API_VIDEOS}/${encodeURIComponent(videoId)}/upload-manifest`;
    const res = await this.axios.get<UploadManifestResponse>(url, { signal });
    if (res.status === 200) {
      if (debug) {
        console.debug(`[vcdn] upload manifest returned ${res.data.uploaded_count ?? res.data.uploaded?.length ?? 0} uploaded segments`);
      }
      return res.data;
    }
    if (res.status === 404 || res.status === 405) {
      if (debug) {
        console.debug(`[vcdn] upload manifest unavailable (HTTP ${res.status}); falling back to per-segment HEAD`);
      }
      return null;
    }
    throw httpVcdnError("GET upload manifest", res);
  }
}
