import React from 'react';

import type { PrimeAPI, PrimeRuntimeStatus } from '@/lib/api/types';

export function usePrimeRuntimeStatus(primeAPI: PrimeAPI | undefined, enabled: boolean) {
  const [status, setStatus] = React.useState<PrimeRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const previousAPIRef = React.useRef(primeAPI);
  const retryRequestRef = React.useRef(0);

  React.useEffect(() => {
    retryRequestRef.current += 1;
    if (!enabled || !primeAPI) {
      setStatus(null);
      setIsLoading(false);
      setLoadFailed(false);
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;
    let hasAuthoritativeStatus = false;
    let statusRequestRevision = 0;
    if (previousAPIRef.current !== primeAPI) {
      previousAPIRef.current = primeAPI;
      setStatus(null);
    }
    setIsLoading(true);
    setLoadFailed(false);
    const loadStatus = () => {
      const requestRevision = statusRequestRevision + 1;
      statusRequestRevision = requestRevision;
      void primeAPI.getStatus(abortController.signal).then((nextStatus) => {
        if (cancelled || statusRequestRevision !== requestRevision) return;
        hasAuthoritativeStatus = true;
        setStatus(nextStatus);
        setIsLoading(false);
        setLoadFailed(false);
      }).catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
        if (!hasAuthoritativeStatus) setLoadFailed(true);
      }).finally(() => {
        if (!cancelled && statusRequestRevision === requestRevision) setIsLoading(false);
      });
    };
    const subscription = primeAPI.subscribe((event) => {
      if (event.type === 'runtime-changed') {
        statusRequestRevision += 1;
        hasAuthoritativeStatus = true;
        setStatus(event.status);
        setIsLoading(false);
        setLoadFailed(false);
      } else if (event.type === 'stream-ready') {
        loadStatus();
      }
    });

    loadStatus();

    return () => {
      cancelled = true;
      abortController.abort();
      subscription.close();
    };
  }, [enabled, primeAPI]);

  const retry = React.useCallback(() => {
    if (!enabled || !primeAPI) return;
    const requestID = retryRequestRef.current + 1;
    retryRequestRef.current = requestID;
    const ownsRequest = () => retryRequestRef.current === requestID && previousAPIRef.current === primeAPI;
    setIsLoading(true);
    setLoadFailed(false);
    void primeAPI.reconnect().then((nextStatus) => {
      if (!ownsRequest()) return;
      setStatus(nextStatus);
      setLoadFailed(false);
    }).catch(() => {
      if (ownsRequest()) setLoadFailed(true);
    }).finally(() => {
      if (ownsRequest()) setIsLoading(false);
    });
  }, [enabled, primeAPI]);

  return {
    status,
    isLoading,
    loadFailed,
    retry,
  };
}
