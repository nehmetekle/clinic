"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { bottomNavForRole } from "@/lib/nav";
import type { Role } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Mobile-only bottom tab bar for the role's most-used destinations. */
export function BottomNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = bottomNavForRole(role);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden">
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
              active ? "text-brand-700" : "text-slate-400 hover:text-slate-600",
            )}
          >
            <Icon className="h-5 w-5" />
            <span>{item.short}</span>
          </Link>
        );
      })}
    </nav>
  );
}
