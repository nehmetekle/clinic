"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { isValidPhone } from "@/components/ui/Field";
import type { Client } from "./types";

/**
 * Debounced exact phone-duplicate lookup, shared by every client-creation form
 * (registration + phone booking) so the "already a client" warning is enforced
 * consistently everywhere a patient can be added. Returns existing patients whose
 * phone matches `phone` — never blocks; the form warns and can still proceed
 * (a genuine second patient may share the line). Only valid phones are looked up,
 * so it stays quiet until enough of the number is entered. `excludeId` drops a
 * client that's already selected (phone booking) from the warning.
 */
export function useDuplicatePhone(
  phone: string,
  { excludeId }: { excludeId?: string } = {},
): Client[] {
  const [matches, setMatches] = useState<Client[]>([]);

  useEffect(() => {
    if (!isValidPhone(phone)) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .findClientsByPhone(phone)
        .then((r) => {
          if (!cancelled) setMatches(r);
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phone]);

  return excludeId ? matches.filter((m) => m.id !== excludeId) : matches;
}
