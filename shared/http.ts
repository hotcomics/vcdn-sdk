import { errorFromResponse, parseErrorBody } from "./errors.js";

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function trimBase(u: string): string {
  return u.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  return base + path;
}

export interface RequestJsonOptions {
  method?: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  /** When true, 204 No Content yields undefined. */
}

export interface RequestBytesOptions {
  path: string;
  method?: "POST";
  body: ArrayBufferView | ArrayBuffer | Blob;
  contentType?: string;
  signal?: AbortSignal;
  retry?: RetryOptions;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  isRetryable?: (res: Response, body: unknown) => boolean;
}

const defaultChunkRetry: NonNullable<RetryOptions["isRetryable"]> = (res, parsed) => {
  if (res.status !== 503) return false;
  const o = parsed as { error?: string } | undefined;
  return o?.error === "upload_chunk_accounting_failed";
};

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

export function createHttpClient(opts: HttpClientOptions) {
  const base = trimBase(opts.baseUrl);
  const fetchFn = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function hdr(extra?: Record<string, string>, json?: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "X-API-Key": opts.apiKey,
      ...extra,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async function requestJson<T>(ro: RequestJsonOptions): Promise<T> {
    const method = ro.method ?? "GET";
    const url = joinUrl(base, ro.path);
    const init: RequestInit = {
      method,
      headers: hdr(undefined, ro.body !== undefined && method !== "GET"),
      signal: ro.signal,
    };
    if (ro.body !== undefined && method !== "GET") {
      init.body = JSON.stringify(ro.body);
    }
    const res = await fetchFn(url, init);
    if (res.status === 204) {
      return undefined as T;
    }
    const parsed = await parseErrorBody(res);
    if (!res.ok) {
      throw errorFromResponse(res.status, res.statusText, parsed);
    }
    return parsed as T;
  }

  async function requestBytes<T>(ro: RequestBytesOptions): Promise<T> {
    const method = ro.method ?? "POST";
    const url = joinUrl(base, ro.path);
    const maxAttempts = Math.max(1, ro.retry?.maxAttempts ?? 4);
    const baseDelay = ro.retry?.baseDelayMs ?? 250;
    const isRetryable = ro.retry?.isRetryable ?? defaultChunkRetry;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetchFn(url, {
        method,
        headers: hdr({
          "Content-Type": ro.contentType ?? "application/octet-stream",
        }),
        body: ro.body as BodyInit,
        signal: ro.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        if (attempt < maxAttempts - 1 && isRetryable(res, parsed)) {
          const jitter = Math.floor(Math.random() * 80);
          await sleep(baseDelay * 2 ** attempt + jitter, ro.signal);
          continue;
        }
        throw errorFromResponse(res.status, res.statusText, parsed);
      }
      return parsed as T;
    }
    throw new Error("unreachable");
  }

  return { baseUrl: base, requestJson, requestBytes };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
