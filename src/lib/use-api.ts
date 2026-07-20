"use client";

import { useCallback, useEffect, useState } from "react";

interface ApiState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
}

/**
 * Loads data from the API and exposes loading/error state plus a `refetch`.
 * `deps` controls when the request re-runs (e.g. a route param).
 *
 * The initial load (and any deps change) flips `loading` so pages can show a
 * full-screen spinner. A manual `refetch()` after a mutation refreshes in the
 * BACKGROUND — it never flips `loading` — so pages that gate on `loading` (e.g.
 * `if (loading) return <Loading/>`) don't unmount and remount their subtree,
 * which would otherwise reset in-view UI state like the active tab.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback((background = false) => {
    if (!background) setLoading(true);
    fetcher()
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  // Manual refetches are background refreshes: keep showing the current data
  // (and preserve in-view state) instead of flashing the full-screen loader.
  return { data, loading, error, refetch: () => load(true) };
}
