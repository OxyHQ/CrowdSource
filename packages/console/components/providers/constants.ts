/**
 * React Query defaults for the whole app.
 */

interface RetriableError {
  status?: number;
}

export const QUERY_CLIENT_CONFIG = {
  defaultOptions: {
    queries: {
      retry: (failureCount: number, error: unknown) => {
        // A 4xx is an answer, not a transient failure — retrying only wastes the
        // operator's time and the server's budget. The console's own hooks refine
        // this further (see `lib/console-api/errors.ts`, `isSettledAnswer`); this
        // is the floor that applies to the SDK's own queries too.
        const status = (error as RetriableError | null)?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),

      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,

      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      refetchOnMount: false,

      structuralSharing: true,
      networkMode: 'online',
    },
    mutations: {
      // A lost response does not prove a write failed. Retrying a credential
      // issue would mint a second token; retrying a secret rotation would rotate
      // twice and invalidate the one the integrator just deployed.
      retry: false,
    },
  },
} as const;
