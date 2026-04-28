export type ApiErrorBody = {
  error?: string;
  message?: string;
  detail?: string;
};

export class VcdnApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly body?: unknown;

  constructor(
    message: string,
    opts: { status: number; code: string; detail?: string; body?: unknown },
  ) {
    super(message);
    this.name = "VcdnApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.body = opts.body;
  }
}

export async function parseErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function errorFromResponse(
  status: number,
  statusText: string,
  parsed: unknown,
): VcdnApiError {
  const o = parsed as ApiErrorBody | undefined;
  const code =
    typeof o?.error === "string" && o.error.trim()
      ? o.error.trim()
      : `http_${status}`;
  const message =
    typeof o?.message === "string" && o.message.trim()
      ? o.message.trim()
      : statusText || `HTTP ${status}`;
  const detail = typeof o?.detail === "string" ? o.detail : undefined;
  return new VcdnApiError(message, { status, code, detail, body: parsed });
}
