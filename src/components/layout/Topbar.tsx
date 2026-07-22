"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarPlus, LogOut, Menu } from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { ROLE_LABELS, currentNav } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { GlobalSearch } from "./GlobalSearch";
import { Notifications } from "./Notifications";

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const settings = useApi(() => api.getSettings());

  // Keep the displayed exchange rates live for every signed-in user: an admin's
  // change in Pricing shows up in others' top bars without a manual reload. We
  // background-refetch on a 60s poll and whenever the tab regains focus/visibility
  // (so a returning user sees the current rate immediately, not on the next tick).
  const refetchSettings = settings.refetch;
  useEffect(() => {
    const id = setInterval(refetchSettings, 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") refetchSettings();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // refetchSettings is stable for the lifetime of the mounted hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const closeAccountMenu = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeAccountMenu);
    return () => document.removeEventListener("mousedown", closeAccountMenu);
  }, []);

  if (!user) return null;

  const usdToLbp = settings.data?.usdToLbp;
  const usdToEur = settings.data?.usdToEur;

  const sectionTitle = currentNav(user.role, pathname)?.label ?? "NutriClinic";

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-white/90 px-4 shadow-[0_1px_0_rgba(15,23,42,0.02)] backdrop-blur-xl lg:px-6">
      <button
        onClick={onMenu}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile: show the current section so users always know where they are */}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700 sm:hidden">
        {sectionTitle}
      </span>

      <GlobalSearch />

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <Button
          size="sm"
          className="rounded-full px-3.5 shadow-none"
          onClick={() => router.push("/appointments/phone-booking")}
        >
          <CalendarPlus className="h-4 w-4" />
          <span className="hidden sm:inline">Appointment</span>
        </Button>

        {(usdToLbp || usdToEur) && (
          <div
            className="hidden items-center px-2 lg:flex xl:px-3"
            title="Live exchange rates (edit in Pricing)"
          >
            <div className="flex items-center gap-2 whitespace-nowrap text-[11px] font-medium text-slate-600 xl:gap-3">
              {usdToLbp && (
                <span>
                  <span className="text-slate-400">USD/LBP</span>{" "}
                  {usdToLbp.toLocaleString("en-US")}
                </span>
              )}
              {usdToLbp && usdToEur && <span className="h-3 w-px bg-slate-200" />}
              {usdToEur && (
                <span>
                  <span className="text-slate-400">USD/EUR</span>{" "}
                  {usdToEur.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                </span>
              )}
            </div>
          </div>
        )}

        <Notifications />

        <div ref={accountRef} className="relative ml-0.5 border-l border-slate-200 pl-2 sm:ml-1 sm:pl-3">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex rounded-full p-0.5 transition hover:bg-brand-50 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            aria-label={`Open account menu for ${user.name}`}
            aria-expanded={menuOpen}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white shadow-sm ring-2 ring-white">
              {user.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
            </div>
          </button>

          {menuOpen && (
            <div
              className={cn(
                "absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10",
              )}
            >
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="truncate text-sm font-semibold text-slate-800">{user.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">{ROLE_LABELS[user.role]}</p>
              </div>
              <button
                onClick={async () => {
                  await logout();
                  router.push("/login");
                }}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
