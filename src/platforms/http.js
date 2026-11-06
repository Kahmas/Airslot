import { openAsBlob } from 'node:fs';

export class TransientError extends Error {}
export class PermanentError extends Error {}
export class AuthError extends PermanentError {}
// A limit that lifts by itself, but only after hours. The scheduler tries again after waitMs.
export class WaitError extends TransientError {
  constructor(message, waitMs) {
    super(message);
    this.waitMs = waitMs;
  }
}

// A failure that also voids the upload session, so a manual retry starts from the beginning.
export function restartError(message) {
  const err = new PermanentError(message);
  err.restart = true;
  return err;
}

const API_TIMEOUT_MS = 60_000;
const UPLOAD_LIMIT_WAIT_MS = 3 * 3_600_000;
const UPLOAD_LIMIT_MESSAGE = "This channel reached YouTube's daily upload limit. It lifts within about 24 hours.";
export const UPLOAD_TIMEOUT_MS = 2 * 3_600_000;

const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613]);
const GOOGLE_TRANSIENT_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError']);
// Seen on real posts that then went through unchanged, whatever flags Meta sends with them.
// "Request processing failed" even says retriable: false. If one is lasting, it still ends in Failed after the retries.
const META_TEMPORARY_MESSAGES = [/^Request processing failed/i, /^Cannot call API for app /i];

export async function send(url, { timeoutMs = API_TIMEOUT_MS, ...init } = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...init });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Some upload endpoints answer with plain text.
    }
    return { status: res.status, headers: res.headers, data, text };
  } catch (err) {
    throw new TransientError(`Could not reach the platform (${err.cause?.code ?? err.name}).`);
  }
}

// Keeps Meta's own codes for the server log, since its messages alone often can't say what went wrong.
export function classify(response) {
  const error = classifyResponse(response);
  const body = response.data?.error;
  const upload = response.data?.debug_info;
  if (body && typeof body === 'object') {
    error.detail = [
      body.code != null && `code ${body.code}`,
      body.error_subcode != null && `subcode ${body.error_subcode}`,
      body.type,
      body.fbtrace_id && `trace ${body.fbtrace_id}`,
      body.log_id && `log ${body.log_id}`,
    ].filter(Boolean).join(', ');
  } else if (upload) {
    error.detail = [`HTTP ${response.status}`, upload.type, upload.retriable != null && `retriable ${upload.retriable}`].filter(Boolean).join(', ');
  }
  return error;
}

function classifyResponse({ status, data, text }) {
  const err = data?.error;
  if (typeof err === 'string') {
    const message = data.error_description ?? err;
    if (err === 'invalid_grant') return new AuthError(message);
    return status >= 500 ? new TransientError(message) : new PermanentError(message);
  }
  const message = err?.error_user_msg ?? err?.message ?? data?.debug_info?.message ?? (text?.slice(0, 200) || `HTTP ${status}`);
  if (err?.code === 190 || status === 401) return new AuthError(message);
  if (META_TEMPORARY_MESSAGES.some((pattern) => pattern.test(message))) return new TransientError(message);
  if (data?.debug_info?.retriable === true) return new TransientError(message);
  if (err?.is_transient || META_TRANSIENT_CODES.has(err?.code)) return new TransientError(message);
  // A per-channel cap, separate from the project's quota. Attempts while it holds stay few, since each one may count.
  if (err?.errors?.[0]?.reason === 'uploadLimitExceeded') return new WaitError(UPLOAD_LIMIT_MESSAGE, UPLOAD_LIMIT_WAIT_MS);
  if (GOOGLE_TRANSIENT_REASONS.has(err?.errors?.[0]?.reason)) return new TransientError(message);
  if (status === 429 || status >= 500) return new TransientError(message);
  return new PermanentError(message);
}

export async function call(url, init) {
  const response = await send(url, init);
  if (response.status >= 200 && response.status < 300) return response.data;
  throw classify(response);
}

export async function openVideo(filePath) {
  try {
    return await openAsBlob(filePath);
  } catch {
    throw new PermanentError('The video file is missing from the server.');
  }
}

export function createGraph(meta) {
  const root = `${meta.graphUrl}/${meta.version}`;
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  return {
    get: (path, token, params = {}) => call(`${root}${path}?${new URLSearchParams(params)}`, { headers: auth(token) }),
    post: (path, token, params = {}) => call(`${root}${path}`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    }),
    postForm: (path, token, form) => call(`${root}${path}`, { method: 'POST', headers: auth(token), body: form }),
    del: (path, token) => call(`${root}${path}`, { method: 'DELETE', headers: auth(token) }),
  };
}

export async function ruploadFile(url, token, filePath, offset = 0) {
  const blob = await openVideo(filePath);
  return call(url, {
    method: 'POST',
    timeoutMs: UPLOAD_TIMEOUT_MS,
    headers: {
      Authorization: `OAuth ${token}`,
      offset: String(offset),
      file_size: String(blob.size),
      'Content-Type': 'application/octet-stream',
    },
    body: blob.slice(offset),
  });
}
