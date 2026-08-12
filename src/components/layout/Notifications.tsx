"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

// First real feed into this panel: low/out-of-stock products (see
// docs — inventory tracking). Visible to every role, same as the product
// catalog itself. More feeds (outstanding ClientDebts, low-session bundles,
// no-shows, ...) can be added the same way — each just contributes its own
// list of { id, label, detail } entries.
function useLowStockAlerts() {
  const products = useApi(() => api.listProducts());
  const lowStock = (products.data ?? [])
    .filter((p) => p.active && p.stock <= p.lowStockThreshold)
    .sort((a, b) => a.stock - b.stock);
  return lowStock;
}

export function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lowStock = useLowStockAlerts();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {lowStock.length > 0 && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-800">Needs attention</p>
          </div>
          {lowStock.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-slate-500">You&apos;re all caught up.</p>
              <p className="mt-1 text-xs text-slate-400">No notifications right now.</p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto py-1">
              {lowStock.map((p) => (
                <Link
                  key={p.id}
                  href="/pricing"
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-slate-50"
                >
                  <span className="truncate text-sm text-slate-700">{p.name}</span>
                  <span className={`shrink-0 text-xs font-medium ${p.stock <= 0 ? "text-rose-600" : "text-amber-600"}`}>
                    {p.stock <= 0 ? `Out of stock (${p.stock})` : `${p.stock} left`}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
