import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setCsrfToken, useCommand } from './client';
function wrapper({children}:{children:ReactNode}){return <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{children}</QueryClientProvider>;}
afterEach(() => { setCsrfToken(''); vi.unstubAllGlobals(); });
describe('authenticated command transport',()=>{
  it('uses cookie authentication, CSRF, and an idempotency key without browser storage',async()=>{const fetchMock=vi.fn().mockResolvedValue(Response.json({data:{id:'record-1'}}));vi.stubGlobal('fetch',fetchMock);setCsrfToken('session-csrf');expect(await api('/orders',{method:'POST',body:{items:[]}})).toEqual({id:'record-1'});expect(fetchMock).toHaveBeenCalledWith('/api/orders',expect.objectContaining({credentials:'include',headers:expect.objectContaining({'x-csrf-token':'session-csrf','Idempotency-Key':expect.any(String)}),body:'{"items":[]}'}));});
  it('reuses one key after an ambiguous connection failure to avoid duplicate financial operations',async()=>{const fetchMock=vi.fn().mockRejectedValueOnce(new TypeError('Connection lost')).mockResolvedValueOnce(Response.json({data:{id:'payment-1'}}));vi.stubGlobal('fetch',fetchMock);const{result}=renderHook(()=>useCommand(),{wrapper});await act(async()=>{await expect(result.current.run('/orders/order-1/payments',{amount:'500',method:'CASH'})).rejects.toThrow('cannot be reached');});await act(async()=>{await result.current.run('/orders/order-1/payments',{amount:'500',method:'CASH'});});const first=fetchMock.mock.calls[0][1].headers['Idempotency-Key'];expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe(first);});
  it('deduplicates simultaneous submissions before the pending state can render',async()=>{let resolve!:(value:Response)=>void;const fetchMock=vi.fn(()=>new Promise<Response>((done)=>{resolve=done;}));vi.stubGlobal('fetch',fetchMock);const{result}=renderHook(()=>useCommand(),{wrapper});await act(async()=>{const first=result.current.run('/orders',{items:[]});const second=result.current.run('/orders',{items:[]});expect(first).toBe(second);resolve(Response.json({data:{id:'order-1'}}));await first;});expect(fetchMock).toHaveBeenCalledTimes(1);});
  it('preserves safe server errors and request references',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{message:'Not enough available stock.',requestId:'stock-check-1'}},{status:409})));await expect(api('/orders',{method:'POST',body:{}})).rejects.toMatchObject({message:'Not enough available stock.',status:409,requestId:'stock-check-1'} satisfies Partial<ApiError>);});
  it('recovers a stale sign-in CSRF token once and retains its idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: { user: null, csrfToken: 'fresh-anonymous-token' } }))
      .mockResolvedValueOnce(Response.json({ data: { user: { id: 'owner-1' }, csrfToken: 'signed-in-token' } }));
    vi.stubGlobal('fetch', fetchMock); setCsrfToken('stale-token');
    await expect(api('/auth/login', { method: 'POST', body: { email: 'owner@example.test', password: 'passphrase' } })).resolves.toMatchObject({ user: { id: 'owner-1' } });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/auth/login', '/api/auth/me', '/api/auth/login']);
    const original = fetchMock.mock.calls[0][1].headers;
    expect(fetchMock.mock.calls[2][1].headers).toMatchObject({ 'x-csrf-token': 'fresh-anonymous-token', 'Idempotency-Key': original['Idempotency-Key'] });
  });
  it('never retries authorization failures or a repeatedly rejected CSRF token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { code: 'FORBIDDEN', message: 'Owner access required.' } }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/settings', { method: 'PATCH', body: {} })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset()
      .mockResolvedValueOnce(Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: { user: null, csrfToken: 'refreshed' } }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 }));
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not replay a protected operation after discovering that the session has ended', async () => {
    const expired = vi.fn(); window.addEventListener('auth:expired', expired);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: { user: null, csrfToken: 'anonymous-token' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(api('/orders', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401, message: 'Your session has ended. Sign in again to continue.' });
      expect(fetchMock).toHaveBeenCalledTimes(2); expect(expired).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('auth:expired', expired); }
  });
  it('never replays a protected action as another account after a cross-tab session change', async () => {
    setCsrfToken('account-a-token');
    const expired = vi.fn(); window.addEventListener('auth:expired', expired);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: { user: { id: 'account-b' }, csrfToken: 'account-b-token' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(api('/orders/order-a/payments', { method: 'POST', body: { amount: '500', method: 'CASH' } })).rejects.toMatchObject({ status: 409, code: 'SESSION_CHANGED', message: 'Your session changed. Review the current workspace before trying again.' });
      expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/orders/order-a/payments', '/api/auth/me']);
      expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
      expect(expired).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('auth:expired', expired); }
  });
  it('shares a session refresh between simultaneous rejected requests', async () => {
    let finishRefresh!: (response: Response) => void;
    const calls = new Map<string, number>();
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/auth/me') return new Promise<Response>(resolve => { finishRefresh = resolve; });
      const count = (calls.get(path) ?? 0) + 1; calls.set(path, count);
      return Promise.resolve(count === 1 ? Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 }) : Response.json({ data: { saved: true } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = api('/auth/login', { method: 'POST', body: {} });
    const second = api('/auth/register', { method: 'POST', body: {} });
    await vi.waitFor(() => expect(finishRefresh).toBeDefined());
    finishRefresh(Response.json({ data: { user: { id: 'owner-1' }, csrfToken: 'refreshed' } }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ saved: true }, { saved: true }]);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/me')).toHaveLength(1);
  });
  it('shows a useful service error for a non-JSON outage and rejects malformed success payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('<h1>Bad gateway</h1>', { status: 502 })).mockResolvedValueOnce(Response.json('unexpected')));
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 502, message: 'The restaurant service is temporarily unavailable. Please try again shortly.' });
    await expect(api('/auth/me')).rejects.toThrow('unexpected response');
  });
  it('respects an aborted request before sending credentials', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController(); controller.abort();
    await expect(api('/auth/login', { method: 'POST', body: {}, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
