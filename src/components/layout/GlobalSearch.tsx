"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, Search, User } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { initials } from "@/lib/utils";

export function GlobalSearch() {
  const router = useRouter();
  const { data: clients } = useApi(() => api.listClients());
  const { data: payments } = useApi(() => api.listPayments());
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const term = q.trim().toLowerCase();
  const clientHits = term
    ? (clients ?? [])
        .filter((c) =>
          `${c.firstName} ${c.lastName} ${c.phone} ${c.email ?? ""}`
            .toLowerCase()
            .includes(term),
        )
        .slice(0, 5)
    : [];
  const paymentHits = term
    ? (payments ?? [])
        .filter((p) => p.receiptNumber.toLowerCase().includes(term))
        .slice(0, 3)
    : [];

  function go(href: string) {
    router.push(href);
    setQ("");
    setOpen(false);
  }

  const hasResults = clientHits.length > 0 || paymentHits.length > 0;

  return (
    <div ref={ref} className="relative hidden flex-1 sm:block sm:max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search clients, phone, receipt…"
        className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      />

      {open && term.length > 0 && (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-96 overflow-y-auto rounded-xl border border-slate-200 bg-white py-2 shadow-lg">
          {!hasResults && (
            <p className="px-4 py-6 text-center text-sm text-slate-400">
              No matches for “{q}”.
            </p>
          )}

          {clientHits.length > 0 && (
            <div>
              <p className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Clients
              </p>
              {clientHits.map((c) => (
                <button
                  key={c.id}
                  onClick={() => go(`/clients/${c.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-slate-50"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                    {initials(c.firstName, c.lastName)}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800">
                      {c.firstName} {c.lastName}
                    </span>
                    <span className="block truncate text-xs text-slate-400">{c.phone}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {paymentHits.length > 0 && (
            <div className="mt-1 border-t border-slate-100 pt-1">
              <p className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Payments
              </p>
              {paymentHits.map((p) => (
                <button
                  key={p.id}
                  onClick={() => go(`/clients/${p.clientId}`)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-slate-50"
                >
                  <CreditCard className="h-4 w-4 text-slate-400" />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-slate-700">{p.receiptNumber}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {p.clientName ? `${p.clientName} · ` : ""}{p.motif}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {hasResults && (
            <button
              onClick={() => go("/clients")}
              className="mt-1 flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2 text-left text-xs font-medium text-brand-700 hover:bg-slate-50"
            >
              <User className="h-3.5 w-3.5" /> View all clients
            </button>
          )}
        </div>
      )}
    </div>
  );
}
