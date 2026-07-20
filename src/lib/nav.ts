import type { Role } from "./types";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  ListChecks,
  Stethoscope,
  TestTubes,
  CreditCard,
  Receipt,
  BarChart3,
  UserCog,
  Settings,
  ScrollText,
  Tags,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  label: string;
  short: string; // compact label for the mobile bottom bar
  href: string;
  icon: LucideIcon;
  roles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", short: "Home", href: "/dashboard", icon: LayoutDashboard, roles: ["secretary", "dietitian", "admin"] },
  { label: "Clients", short: "Clients", href: "/clients", icon: Users, roles: ["secretary", "dietitian", "admin"] },
  { label: "Today's Queue", short: "Queue", href: "/queue", icon: ListChecks, roles: ["secretary", "dietitian", "admin"] },
  { label: "Appointments", short: "Appts", href: "/appointments", icon: CalendarDays, roles: ["secretary", "dietitian", "admin"] },
  { label: "Consultations", short: "Consults", href: "/consultations", icon: Stethoscope, roles: ["dietitian", "admin"] },
  { label: "Blood Samples", short: "Samples", href: "/blood-samples", icon: TestTubes, roles: ["secretary", "admin"] },
  { label: "Payments", short: "Payments", href: "/payments", icon: CreditCard, roles: ["secretary", "admin"] },
  { label: "Expenses", short: "Expenses", href: "/expenses", icon: Receipt, roles: ["secretary", "admin"] },
  { label: "Reports", short: "Reports", href: "/reports", icon: BarChart3, roles: ["admin"] },
  { label: "Pricing", short: "Pricing", href: "/pricing", icon: Tags, roles: ["admin"] },
  { label: "Staff", short: "Staff", href: "/staff", icon: UserCog, roles: ["admin"] },
  { label: "Audit Log", short: "Audit", href: "/audit", icon: ScrollText, roles: ["admin"] },
  { label: "Settings", short: "Settings", href: "/settings", icon: Settings, roles: ["admin"] },
];

export function navForRole(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Up to five most-used destinations for the mobile bottom bar. */
export function bottomNavForRole(role: Role): NavItem[] {
  return navForRole(role).slice(0, 5);
}

/** The nav item matching the current path (for the mobile section title). */
export function currentNav(role: Role, pathname: string): NavItem | undefined {
  return navForRole(role).find(
    (i) => pathname === i.href || pathname.startsWith(i.href + "/"),
  );
}

export function canAccess(role: Role, href: string): boolean {
  const item = NAV_ITEMS.find((i) => href === i.href || href.startsWith(i.href + "/"));
  if (!item) return true; // unlisted routes (e.g. client detail) are allowed
  return item.roles.includes(role);
}

/** Where a role lands right after login (docs/01-product-spec.md §3.1: Secretary
 * → queue, Dietitian/Admin → overview — both render from /dashboard, which
 * already branches on role). */
export function roleHome(role: Role): string {
  return role === "secretary" ? "/queue" : "/dashboard";
}

export const ROLE_LABELS: Record<Role, string> = {
  secretary: "Secretary / Receptionist",
  dietitian: "Dietitian",
  admin: "Admin / Owner",
};
