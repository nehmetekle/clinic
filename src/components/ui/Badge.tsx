import { cn } from "@/lib/utils";
import type { AppointmentStatus } from "@/lib/types";

const tones: Record<string, string> = {
  gray: "bg-slate-100 text-slate-700",
  blue: "bg-blue-100 text-blue-700",
  amber: "bg-amber-100 text-amber-700",
  purple: "bg-purple-100 text-purple-700",
  green: "bg-emerald-100 text-emerald-700",
  red: "bg-rose-100 text-rose-700",
  darkred: "bg-rose-200 text-rose-900",
};

export function Badge({
  tone = "gray",
  className,
  children,
}: {
  tone?: keyof typeof tones;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const apptTone: Record<AppointmentStatus, keyof typeof tones> = {
  scheduled: "gray",
  checked_in: "blue",
  with_dietitian: "purple",
  completed: "green",
  cancelled: "red",
  no_show: "darkred",
};

const apptLabel: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  checked_in: "Checked in",
  with_dietitian: "With dietitian",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export function AppointmentBadge({ status }: { status: AppointmentStatus }) {
  return <Badge tone={apptTone[status]}>{apptLabel[status]}</Badge>;
}
