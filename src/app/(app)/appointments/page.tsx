"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, CalendarPlus, CalendarSearch, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AppointmentBadge, Badge } from "@/components/ui/Badge";
import { FormRow, Input } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import {
  isReschedulable,
  RescheduleAppointmentModal,
} from "@/components/ScheduleAppointmentModal";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { clinicDay, todayIso } from "@/lib/config";
import { VISIT_TYPE_LABELS } from "@/lib/types";
import type { Appointment } from "@/lib/types";
import { cn, formatDate, formatTime } from "@/lib/utils";

export default function AppointmentsPage() {
  const router = useRouter();
  const { user } = useSession();
  const isClinical = user?.role === "dietitian" || user?.role === "admin";
  const isDietitian = user?.role === "dietitian";
  // Dietitians can't book appointments — booking is a secretary/admin action.
  const canBook = user?.role !== "dietitian";
  // Deliberately a *positive* role test rather than reusing `canBook`'s "not a
  // dietitian": `canBook` also passes while `user` is still undefined, which
  // would flash a Reschedule button the API answers with 403. Mirrors
  // `canManageAppointments` on the server exactly.
  const canManageAppointments = user?.role === "secretary" || user?.role === "admin";
  // A doctor only ever works on their own visits/bookings, so ask the server for
  // just those (admins/secretary are unaffected — the flag is ignored server-side
  // for them). Keyed on the role: `user` resolves a tick after mount, so without
  // the dep the first (unscoped) request would be the one whose data sticks.
  const { data, loading, error, refetch } = useApi(
    () => api.listAppointments(isDietitian ? { scope: "mine" } : undefined),
    [isDietitian],
  );
  const consultations = useApi(
    () => api.listConsultations(isDietitian ? { scope: "mine" } : undefined),
    [isDietitian],
  );
  const machineVisits = useApi(
    () => api.listMachineVisits(isDietitian ? { scope: "mine" } : undefined),
    [isDietitian],
  );

  const [selectedDate, setSelectedDate] = useState(todayIso());
  // Moving a booking to another slot — front desk only, same right as booking.
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  // The unclosed-visits list starts collapsed — the count in the header is the
  // signal; the rows are only needed once someone acts on it.
  const [openVisitsExpanded, setOpenVisitsExpanded] = useState(false);

  const appointments = data ?? [];
  const allVisits = consultations.data ?? [];

  const dayAppts = appointments
    .filter((a) => a.date === selectedDate)
    .sort((a, b) => a.time.localeCompare(b.time));
  const dayVisits = allVisits.filter((c) => c.date === selectedDate);
  // Purpose isn't a stored field on a consultation — derive it from what the
  // visit actually did, since a machine-only attendance never creates one of
  // these rows at all (it's a MachineVisit, merged in separately below).
  const visitPurpose = (c: (typeof dayVisits)[number]) => {
    if (c.bloodCollection || (c.bloodTests && c.bloodTests.length > 0)) return "Blood Test";
    return c.visitNumber === 1 ? "Initial" : "Follow-up";
  };
  // `MachineVisit.date` is a full timestamp (`toISOString()`), unlike a
  // consultation's date-only string — so it must be narrowed to the clinic day
  // before comparing. A raw `m.date === selectedDate` never matches anything and
  // silently hid every machine visit from this page.
  const dayMachineVisits = (machineVisits.data ?? []).filter(
    (m) => clinicDay(new Date(m.date)) === selectedDate && !m.voidedAt,
  );
  // Every visit still open, regardless of the date being viewed: a draft left
  // unclosed on an earlier day is exactly the one nobody goes looking for, so
  // it is surfaced here rather than only inside its own day's table. Oldest
  // first — the longest-open one is the most urgent.
  const openVisits = allVisits
    .filter((c) => c.status === "open")
    .sort((a, b) => a.date.localeCompare(b.date) || a.visitNumber - b.visitNumber);

  return (
    <div>
      <PageHeader
        title="Appointments & history"
        subtitle="Pick a date to see the patients we had that day."
        action={
          canBook ? (
            <Button onClick={() => router.push("/appointments/phone-booking")}>
              <CalendarPlus className="h-4 w-4" /> Schedule appointment
            </Button>
          ) : null
        }
      />

      {/* Date picker */}
      <Card className="mb-6">
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <FormRow label="View date" className="w-44">
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </FormRow>
            <Button
              variant={selectedDate === todayIso() ? "primary" : "outline"}
              onClick={() => setSelectedDate(todayIso())}
            >
              Today
            </Button>
          </div>
        </CardBody>
      </Card>

      {loading || consultations.loading || machineVisits.loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <div className="space-y-6">
          {isClinical && openVisits.length > 0 && (
            <Card>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-5 py-3 text-left"
                aria-expanded={openVisitsExpanded}
                onClick={() => setOpenVisitsExpanded((v) => !v)}
              >
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-sm font-semibold text-slate-800">
                  {openVisits.length} consultation{openVisits.length !== 1 ? "s" : ""} not closed
                </p>
                <ChevronDown
                  className={cn(
                    "ml-auto h-4 w-4 text-slate-400 transition-transform",
                    openVisitsExpanded && "rotate-180",
                  )}
                />
              </button>
              {openVisitsExpanded && (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {openVisits.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{c.clientName}</p>
                      <p className="text-xs text-slate-400">
                        Visit #{c.visitNumber} · {formatDate(c.date)} · {c.dietitianName}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        router.push(`/consultations/new?client=${c.clientId}&consultation=${c.id}`)
                      }
                    >
                      Continue
                    </Button>
                  </li>
                ))}
              </ul>
              )}
            </Card>
          )}

          <Card>
            <CardHeader
              title={`Patients on ${formatDate(selectedDate)}`}
              subtitle={`${dayAppts.length} appointment${dayAppts.length !== 1 ? "s" : ""} scheduled`}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Patient</TH>
                  <TH>Doctor</TH>
                  <TH>Visit type</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {dayAppts.map((a) => (
                  <TR key={a.id} onClick={() => router.push(`/clients/${a.clientId}`)}>
                    <TD className="font-medium">{formatTime(a.time)}</TD>
                    <TD>{a.clientName}</TD>
                    <TD className="text-slate-500">{a.dietitianName}</TD>
                    <TD className="text-slate-500">{VISIT_TYPE_LABELS[a.visitType] ?? a.visitType}</TD>
                    <TD><AppointmentBadge status={a.status} /></TD>
                    <TD>
                      <div className="flex items-center justify-end gap-3">
                        {canManageAppointments && isReschedulable(a) && (
                          <Button
                            size="sm"
                            variant="outline"
                            // The row itself navigates to the profile — keep the
                            // click here from doing both.
                            onClick={(e) => {
                              e.stopPropagation();
                              setRescheduleTarget(a);
                            }}
                          >
                            <CalendarClock className="h-3.5 w-3.5" /> Reschedule
                          </Button>
                        )}
                        {/* The whole row opens the patient profile; the real status
                            lives in the badge column, so this is just that affordance. */}
                        <span className="text-xs font-medium text-brand-700">View</span>
                      </div>
                    </TD>
                  </TR>
                ))}
                {dayAppts.length === 0 && (
                  <TR>
                    <TD colSpan={6} className="py-8 text-center text-slate-400">
                      No appointments scheduled on this date.
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </Card>

          {isClinical && (
          <Card>
            <CardHeader
              title={`Consultations recorded on ${formatDate(selectedDate)}`}
              subtitle={`${dayVisits.length + dayMachineVisits.length} visit${
                dayVisits.length + dayMachineVisits.length !== 1 ? "s" : ""
              } recorded`}
              action={<CalendarSearch className="h-4 w-4 text-slate-400" />}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Patient</TH>
                  <TH>Visit</TH>
                  <TH>Purpose</TH>
                  <TH>Doctor</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {dayVisits.map((c) => (
                  <TR key={c.id} onClick={() => router.push(`/clients/${c.clientId}`)}>
                    <TD className="font-medium">{c.clientName}</TD>
                    <TD>#{c.visitNumber}</TD>
                    <TD className="text-slate-500">{visitPurpose(c)}</TD>
                    <TD className="text-slate-500">{c.dietitianName}</TD>
                    <TD>
                      {c.status === "open" ? (
                        <Badge tone="amber">In progress</Badge>
                      ) : (
                        <Badge tone="green">Done</Badge>
                      )}
                    </TD>
                    <TD>
                      {/* An open visit reopens directly in the editor; a closed one
                          is read-only, so the row-click to the profile is enough. */}
                      {c.status === "open" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(
                              `/consultations/new?client=${c.clientId}&consultation=${c.id}`,
                            );
                          }}
                        >
                          Continue
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
                {dayMachineVisits.map((m) => (
                  <TR key={m.id} onClick={() => router.push(`/clients/${m.clientId}`)}>
                    <TD className="font-medium">{m.clientName}</TD>
                    <TD>—</TD>
                    <TD className="text-slate-500">Machine</TD>
                    <TD className="text-slate-500">{m.recordedByName}</TD>
                    <TD>
                      <Badge tone="green">Done</Badge>
                    </TD>
                    {/* No action: a machine visit has no detail view of its own and
                        nothing to reopen. The row click already goes to the client
                        profile, where it appears in the history stream. */}
                    <TD />
                  </TR>
                ))}
                {dayVisits.length === 0 && dayMachineVisits.length === 0 && (
                  <TR>
                    <TD colSpan={6} className="py-8 text-center text-slate-400">
                      No consultations recorded on this date.
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </Card>
          )}
        </div>
      )}

      <RescheduleAppointmentModal
        appointment={rescheduleTarget}
        onClose={() => setRescheduleTarget(null)}
        onRescheduled={refetch}
      />
    </div>
  );
}
