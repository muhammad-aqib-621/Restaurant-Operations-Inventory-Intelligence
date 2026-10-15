import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type Role = 'OWNER' | 'MANAGER' | 'CASHIER' | 'KITCHEN' | 'INVENTORY';
export interface User { id: string; name: string; email: string; role: Role; active: boolean }
export interface AuthData { user: User | null; csrfToken: string }
let csrfToken = '';
export function setCsrfToken(token: string) { csrfToken = token; }
export class ApiError extends Error {
  constructor(message: string, public status = 0, public requestId?: string) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const writing = !['GET', 'HEAD'].includes(method.toUpperCase());
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (writing) { headers['x-csrf-token'] = csrfToken; headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID(); }
  let response: Response;
  try { response = await fetch(`/api${path}`, { method, headers, credentials: 'include', ...(options.signal ? { signal: options.signal } : {}), ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }); }
  catch (problem) { if (options.signal?.aborted) throw problem; throw new ApiError('The service cannot be reached. Check your connection and try again.'); }
  const result = await response.json().catch(() => null) as { data?: T; error?: { message?: string; requestId?: string } } | null;
  if (options.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(result?.error?.message ?? 'The request could not be completed.', response.status, result?.error?.requestId);
  }
  if (!result || !('data' in result)) throw new ApiError('The service returned an unexpected response. Please retry.');
  const data = result.data as T;
  if (data && typeof data === 'object' && 'csrfToken' in data) setCsrfToken(String(data.csrfToken));
  return data;
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
