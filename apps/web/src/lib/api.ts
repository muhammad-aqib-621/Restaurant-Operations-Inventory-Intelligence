import { QueryClient, useQuery } from '@tanstack/react-query';
import { readinessSchema, type ReadinessResponse } from '@nk/shared';

export type Readiness = ReadinessResponse['data'];

export interface Health {
  status: 'ok';
  service: 'api';
}

export class ApiError extends Error {
  constructor(message: string, public readonly requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string, signal: AbortSignal, parse: (body: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Check that the restaurant service is running, then try again.');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = body as { error?: { message?: string; requestId?: string } } | null;
    throw new ApiError(
      problem?.error?.message || 'The restaurant service is temporarily unavailable. Please try again.',
      problem?.error?.requestId,
    );
  }
  try {
    return parse(body);
  } catch {
    throw new ApiError('The restaurant service returned an unexpected response. Please try again.');
  }
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: true },
    },
  });
}

export function useWorkspace() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => get<Health>('/api/health', signal, (body) => {
      const data = (body as { data?: Partial<Health> } | null)?.data;
      if (data?.status !== 'ok' || data.service !== 'api') throw new Error('Invalid health response');
      return { status: 'ok', service: 'api' };
    }),
  });
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: ({ signal }) => get('/api/readiness', signal, (body) => readinessSchema.parse(body).data),
  });
  return {
    health,
    readiness,
    refresh: () => Promise.all([health.refetch(), readiness.refetch()]),
    refreshing: health.isFetching || readiness.isFetching,
  };
}
