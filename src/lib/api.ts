import type { z } from 'zod';

/** Base URL for API requests. Empty string uses the same origin (Vite proxy handles it in dev). */
const API_BASE = '';

/** API error with status code, parsed body, and HTTP status text. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly statusText: string = '',
  ) {
    super(`API error ${status}`);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  options: {
    body?: unknown;
    schema?: z.ZodType<T>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { body, schema, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchInit: RequestInit = { method, headers };
  if (body !== undefined) fetchInit.body = JSON.stringify(body);
  if (signal !== undefined) fetchInit.signal = signal;

  const res = await fetch(`${API_BASE}${path}`, fetchInit);

  if (!res.ok) {
    const errorText = await res.text();
    let errorBody: unknown;
    try {
      errorBody = JSON.parse(errorText);
    } catch {
      errorBody = errorText;
    }
    throw new ApiError(res.status, errorBody, res.statusText);
  }

  const json: unknown = await res.json();

  if (schema) {
    return schema.parse(json);
  }

  return json as T;
}

/** Type-safe GET request. */
export function apiGet<T>(
  path: string,
  schema?: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const opts: { schema?: z.ZodType<T>; signal?: AbortSignal } = {};
  if (schema !== undefined) opts.schema = schema;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('GET', path, opts);
}

/**
 * Fail-open GET request. Returns `fallback` on any error (HTTP error, network
 * failure, or malformed JSON) instead of throwing — for callers that render a
 * default rather than an error state.
 */
export async function apiGetSafe<T>(
  path: string,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await apiGet<T>(path, undefined, signal);
  } catch {
    return fallback;
  }
}

/** Type-safe POST request. */
export function apiPost<T>(
  path: string,
  body: unknown,
  schema?: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const opts: { body: unknown; schema?: z.ZodType<T>; signal?: AbortSignal } = { body };
  if (schema !== undefined) opts.schema = schema;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('POST', path, opts);
}

/** Type-safe PUT request. */
export function apiPut<T>(
  path: string,
  body: unknown,
  schema?: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const opts: { body: unknown; schema?: z.ZodType<T>; signal?: AbortSignal } = { body };
  if (schema !== undefined) opts.schema = schema;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('PUT', path, opts);
}

/** Type-safe PATCH request. */
export function apiPatch<T>(
  path: string,
  body: unknown,
  schema?: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const opts: { body: unknown; schema?: z.ZodType<T>; signal?: AbortSignal } = { body };
  if (schema !== undefined) opts.schema = schema;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('PATCH', path, opts);
}

/** Type-safe DELETE request. */
export function apiDelete<T>(
  path: string,
  schema?: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const opts: { schema?: z.ZodType<T>; signal?: AbortSignal } = {};
  if (schema !== undefined) opts.schema = schema;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('DELETE', path, opts);
}
