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
        // reviewer's time and the server's budget.
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
      // A lost response does not prove a write failed. Retrying a submitted
      // review or a recusal could record it twice.
      retry: false,
    },
  },
} as const;
