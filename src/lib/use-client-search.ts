"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import type { Client } from "./types";

/**
 * Debounced, server-side client search — the single implementation behind every
 * "find a patient" box (client list, phone booking, record payment). Always hits
 * `/api/clients?q=` so name/phone/email matching stays in one place on the server.
 *
 * `minChars` sets the query length before searching:
 *  - `>= 1` (pickers): below the threshold returns nothing, so an empty box shows
 *    no dropdown.
 *  - `0` (browse lists): an empty query returns every client (a plain list load),
 *    and typing narrows it.
 */
export function useClientSearch(
  query: string,
  { minChars = 1, debounceMs = 250 }: { minChars?: number; debounceMs?: number } = {},
): { results: Client[]; loading: boolean; error?: string } {
  const [results, setResults] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const term = query.trim();
    if (minChars > 0 && term.length < minChars) {
      setResults([]);
      setLoading(false);
      setError(undefined);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      // Empty term (only reachable when minChars === 0) lists everyone.
      (term ? api.searchClients(term) : api.listClients())
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setError(undefined);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) {
            setResults([]);
            setError(e.message);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, minChars, debounceMs]);

  return { results, loading, error };
}
