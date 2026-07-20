"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, Stethoscope, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AppointmentBadge } from "@/components/ui/Badge";
import { Loading, ErrorState } from "@/components/ui/States";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { VISIT_TYPE_LABELS } from "@/lib/types";
import { formatDate, formatTime } from "@/lib/utils";

export function DietitianDashboard() {
  const router = useRouter();
  const { user } = useSession();
  const { data, loading, error } = useApi(() => api.getDashboard());

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const me = user?.name ?? "";
  const today = data.todaysAppointments.filter((a) => a.dietitianName === me);
  const waiting = today.filter((a) => a.status === "checked_in");
  const recentConsults = data.recentConsultations
    .filter((c) => c.dietitianName === me)
    .slice(0, 4);

  return (
    <div>
      <PageHeader
        title="Today's clients"
        subtitle="Clients scheduled or checked in for your consultations today."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard label="Today's clients" value={today.length} icon={Users} tone="brand" />
        <StatCard label="Waiting now" value={waiting.length} icon={CalendarClock} tone="amber" />
        <StatCard
          label="Completed today"
          value={today.filter((a) => a.status === "completed").length}
          icon={Stethoscope}
          tone="green"
        />
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader title="Today's appointments" subtitle="Open a profile or start a consultation." />
          <CardBody className="space-y-3">
            {today.length === 0 && (
              <p className="text-sm text-slate-400">No clients scheduled for you today.</p>
            )}
            {today.map((a) => (
              <div
                key={a.id}
                className="flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="w-14 text-center">
                    <p className="text-sm font-semibold text-slate-800">{formatTime(a.time)}</p>
                    <p className="text-[11px] uppercase text-slate-400">
                      {VISIT_TYPE_LABELS[a.visitType] ?? a.visitType}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium text-slate-800">{a.clientName}</p>
                    {a.referralSource && (
                      <p className="text-xs text-slate-500">Referrer: {a.referralSource}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <AppointmentBadge status={a.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(`/clients/${a.clientId}`)}
                  >
                    Profile
                  </Button>
                  {a.intakeComplete ? (
                    <Button
                      size="sm"
                      onClick={() => router.push(`/clients/${a.clientId}`)}
                    >
                      Start ▶
                    </Button>
                  ) : (
                    // Intake not completed yet — the dietitian must check the
                    // patient in (fill the required details) before starting.
                    <Button
                      size="sm"
                      variant="outline"
                      title="Complete check-in before starting"
                      onClick={() =>
                        router.push(
                          `/clients/${a.clientId}/checkin?appt=${a.id}&return=/clients/${a.clientId}`,
                        )
                      }
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Check in
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader title="Recent consultations" />
          <CardBody className="space-y-3">
            {recentConsults.length === 0 && (
              <p className="text-sm text-slate-400">No recent consultations.</p>
            )}
            {recentConsults.map((c) => (
              <Link
                key={c.id}
                href={`/clients/${c.clientId}`}
                className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium text-slate-800">{c.clientName}</p>
                  <p className="text-xs text-slate-500">
                    {formatDate(c.date)} · Visit #{c.visitNumber}
                  </p>
                </div>
                {c.deltaKg !== undefined && (
                  <span
                    className={`text-sm font-medium ${
                      c.deltaKg <= 0 ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {c.deltaKg > 0 ? "+" : ""}
                    {c.deltaKg} kg
                  </span>
                )}
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
