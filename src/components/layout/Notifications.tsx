"use client";

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";

// Notifications are not a real feature yet: there is no backend feed, so rather
// than show hardcoded/fake alerts the panel renders an honest empty state. When
// this becomes a real feature it should read from live data (e.g. outstanding
// ClientDebts, low-session bundles, no-shows) — never a hardcoded list.
export function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-800">Needs attention</p>
          </div>
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-slate-500">You&apos;re all caught up.</p>
            <p className="mt-1 text-xs text-slate-400">No notifications right now.</p>
          </div>
        </div>
      )}
    </div>
  );
}
