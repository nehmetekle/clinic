"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown, LogOut, Menu, PhoneCall } from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { ROLE_LABELS, currentNav } from "@/lib/nav";
import { todayIso } from "@/lib/config";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { GlobalSearch } from "./GlobalSearch";
import { Notifications } from "./Notifications";

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const settings = useApi(() => api.getSettings());

  if (!user) return null;

  const usdToLbp = settings.data?.usdToLbp;

  const sectionTitle = currentNav(user.role, pathname)?.label ?? "NutriClinic";
  const canBook = user.role === "secretary" || user.role === "admin";

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:px-6">
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

      <div className="ml-auto flex items-center gap-2">
        {canBook && (
          <Button size="sm" onClick={() => router.push("/appointments/phone-booking")}>
            <PhoneCall className="h-4 w-4" />
            <span className="hidden sm:inline">Phone booking</span>
          </Button>
        )}

        {usdToLbp && (
          <span
            className="hidden items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600 md:flex"
            title="USD → LBP exchange rate (edit in Pricing)"
          >
            <span className="text-slate-400">Rate</span>
            1 USD = {usdToLbp.toLocaleString("en-US")} LBP
          </span>
        )}

        <span className="hidden text-xs text-slate-400 md:block">
          {formatDate(todayIso())}
        </span>

        <Notifications />

        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-100"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
              {user.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
            </div>
            <div className="hidden text-left sm:block">
              <p className="text-xs font-semibold text-slate-700">{user.name}</p>
              <p className="text-[11px] text-slate-400">{ROLE_LABELS[user.role]}</p>
            </div>
            <ChevronDown className="hidden h-4 w-4 text-slate-400 sm:block" />
          </button>

          {menuOpen && (
            <div
              className={cn(
                "absolute right-0 mt-2 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg",
              )}
            >
              <button
                onClick={async () => {
                  await logout();
                  router.push("/login");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
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
