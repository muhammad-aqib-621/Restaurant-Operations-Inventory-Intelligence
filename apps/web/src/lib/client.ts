import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type Role = 'OWNER' | 'MANAGER' | 'CASHIER' | 'KITCHEN' | 'INVENTORY';
export interface User { id: string; name: string; email: string; role: Role; active: boolean }
export interface AuthData { user: User | null; csrfToken: string }
let csrfToken = '';
let sessionRefresh: Promise<AuthData> | null = null;
export function setCsrfToken(token: string) { csrfToken = token; }
export class ApiError extends Error {
  constructor(message: string, public status = 0, public requestId?: string, public code?: string) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const writing = !['GET', 'HEAD'].includes(method.toUpperCase());
  const idempotencyKey = writing ? options.idempotencyKey ?? crypto.randomUUID() : undefined;
  async function send(canRefresh: boolean): Promise<T> {
    if (options.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (writing) { headers['x-csrf-token'] = csrfToken; headers['Idempotency-Key'] = idempotencyKey!; }
    let response: Response;
    try { response = await fetch(`/api${path}`, { method, headers, credentials: 'include', ...(options.signal ? { signal: options.signal } : {}), ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }); }
    catch (problem) { if (options.signal?.aborted) throw problem; throw new ApiError('The service cannot be reached. Check your connection and try again.'); }
    const result = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string; requestId?: string } } | null;
    if (options.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    // Refresh the token, but replay only sign-in/access requests. Another tab may
    // have changed accounts, so a protected action needs fresh user confirmation.
    if (writing && canRefresh && response.status === 403 && result?.error?.code === 'CSRF_REJECTED') {
      sessionRefresh ??= api<AuthData>('/auth/me').finally(() => { sessionRefresh = null; });
      const session = await sessionRefresh;
      if (path !== '/auth/login' && path !== '/auth/register') {
        window.dispatchEvent(new Event('auth:expired'));
        if (!session.user) throw new ApiError('Your session has ended. Sign in again to continue.', 401);
        throw new ApiError('Your session changed. Review the current workspace before trying again.', 409, undefined, 'SESSION_CHANGED');
      }
      return send(false);
    }
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('auth:expired'));
      const message = response.status >= 500 ? 'The restaurant service is temporarily unavailable. Please try again shortly.' : result?.error?.message ?? 'The request could not be completed. Please try again.';
      throw new ApiError(message, response.status, result?.error?.requestId, result?.error?.code);
    }
    if (!result || typeof result !== 'object' || !('data' in result)) throw new ApiError('The service returned an unexpected response. Please retry.');
    const data = result.data as T;
    if (data && typeof data === 'object' && 'csrfToken' in data && typeof data.csrfToken === 'string') setCsrfToken(data.csrfToken);
    return data;
  }
  return send(true);
}
export function useData<T>(path: string) { return useQuery({ queryKey: ['api', path], queryFn: ({ signal }) => api<T>(path, { signal }) }); }
export function useList<T>(path: string) { return useData<T[]>(path); }
export function queryPath(path: string, filters: Record<string, string | number | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '' && value !== undefined && value !== null) query.set(key, String(value));
  return query.size ? `${path}?${query}` : path;
}
export function useCommand() {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef<{ signature: string; promise: Promise<unknown> } | null>(null);
  const run = <T = unknown>(path: string, body: unknown, method = 'POST'): Promise<T> => {
    const signature = JSON.stringify([method, path, body]);
    if (inFlight.current) {
      if (inFlight.current.signature === signature) return inFlight.current.promise as Promise<T>;
      return Promise.reject(new Error('Wait for the current request to finish.'));
    }
    const key = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, key);
    setPending(true); setError(null);
    const promise = (async () => {
      try {
        const result = await api<T>(path, { method, body, idempotencyKey: key });
        keys.current.delete(signature);
        await client.invalidateQueries({ queryKey: ['api'] });
        return result;
      } catch (problem) {
        if (problem instanceof ApiError && problem.status >= 400 && problem.status < 500) keys.current.delete(signature);
        setError(problem instanceof Error ? problem.message : 'Request failed.');
        throw problem;
      } finally { inFlight.current = null; setPending(false); }
    })();
    inFlight.current = { signature, promise };
    return promise;
  };
  return { pending, error, run };
}
export function businessDate(value = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value); }
export function dateTime(value: string) { return new Intl.DateTimeFormat('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
