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
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  // `enabled: false` holds the request back without discarding what is already
  // loaded — for a form whose inputs are mid-edit and not yet a valid query.
  // Loading stops, so a page gated on `loading` stays interactive.
  opts: { enabled?: boolean } = {},
): ApiState<T> {
  const enabled = opts.enabled ?? true;
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback((background = false) => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (!background) setLoading(true);
    fetcher()
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [enabled, ...deps]);

  useEffect(() => {
    load();
  }, [load]);

  // Manual refetches are background refreshes: keep showing the current data
  // (and preserve in-view state) instead of flashing the full-screen loader.
  return { data, loading, error, refetch: () => load(true) };
}

/**
 * Polls `refetch` on an interval for near-real-time boards (e.g. the queue),
 * without a push mechanism. Paused while the tab is hidden (Page Visibility
 * API) so a backgrounded tab doesn't keep hitting the API, and resumed (with
 * an immediate refetch) when it becomes visible again.
 *
 * `refetch` from `useApi` is already a background load — it never flips
 * `loading` — so polling here doesn't introduce any spinner/flicker.
 */
export function useAutoRefetch(refetch: () => void, intervalMs: number): void {
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    function start() {
      if (interval) return;
      interval = setInterval(refetch, intervalMs);
    }
    function stop() {
      clearInterval(interval);
      interval = undefined;
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stop();
      } else {
        refetch();
        start();
      }
    }

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);
}
