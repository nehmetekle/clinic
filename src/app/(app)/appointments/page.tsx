"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, CalendarPlus, CalendarSearch, CheckCircle2, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AppointmentBadge, Badge } from "@/components/ui/Badge";
import { FormRow, Input } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { Modal } from "@/components/ui/Modal";
import {
  isReschedulable,
  RescheduleAppointmentModal,
} from "@/components/ScheduleAppointmentModal";
import { useApi, useAutoRefetch } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { clinicDay, todayIso } from "@/lib/config";
import { VISIT_TYPE_LABELS } from "@/lib/types";
import type { Appointment, ConsultationListItem } from "@/lib/types";
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
  // Only the PENDING baskets: they are what blocks a close (V-close rule), and a
  // visit whose basket is settled simply isn't in this list. Same gate the visit
  // editor applies — see `closeBlocked` in consultations/new/page.tsx — minus its
  // unsaved-form arm, which can't apply to a visit being closed from a list.
  const pendingBaskets = useApi(() => api.listVisitBaskets({ status: "pending" }), []);

  // Near-real-time, at the queue board's cadence and for the same reason: the
  // settlement that unlocks "Close visit" happens on the SECRETARY's screen, so
  // without this the doctor sits in front of a greyed-out button that is already
  // wrong and has no way to know. Polling all three keeps the row consistent —
  // the button's gate (baskets), the visit's own status (a visit closed in
  // another tab), and the appointment badge a close flips to Completed.
  // Background refetches never flip `loading`, so there's no spinner or flicker,
  // and the hook parks the timer while the tab is hidden.
  useAutoRefetch(pendingBaskets.refetch, 4000);
  useAutoRefetch(consultations.refetch, 4000);
  useAutoRefetch(refetch, 4000);

  const [selectedDate, setSelectedDate] = useState(todayIso());
  // Moving a booking to another slot — front desk only, same right as booking.
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  // The unclosed-visits list starts collapsed — the count in the header is the
  // signal; the rows are only needed once someone acts on it.
  const [openVisitsExpanded, setOpenVisitsExpanded] = useState(false);
  const { toast } = useToast();
  // Closing is irreversible (a closed visit is read-only), and a list row is far
  // easier to misclick than the editor's footer button — so it is confirmed.
  const [closeTarget, setCloseTarget] = useState<ConsultationListItem | null>(null);
  const [closing, setClosing] = useState(false);

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
  const unsettledVisitIds = new Set(
    (pendingBaskets.data ?? []).map((b) => b.consultationId).filter(Boolean) as string[],
  );

  async function confirmClose() {
    if (!closeTarget) return;
    setClosing(true);
    try {
      await api.closeConsultation(closeTarget.id);
      toast("Visit closed");
      setCloseTarget(null);
      consultations.refetch();
      pendingBaskets.refetch();
      // The close completes the booking it was started from, so the day's
      // appointment rows change too.
      refetch();
    } catch (e) {
      // The server is the authority (ownership, a basket settled in another tab,
      // a visit someone else just closed) — show what it said and leave the row.
      toast((e as Error).message);
    } finally {
      setClosing(false);
    }
  }

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
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          router.push(`/consultations/new?client=${c.clientId}&consultation=${c.id}`)
                        }
                      >
                        Continue
                      </Button>
                      <CloseVisitButton
                        blocked={unsettledVisitIds.has(c.id)}
                        onClick={() => setCloseTarget(c)}
                      />
                    </div>
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
                        <div className="flex items-center justify-end gap-2">
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
                          {/* Settled bill, nothing left to record: finalize here
                              instead of a round trip through the editor. */}
                          <CloseVisitButton
                            blocked={unsettledVisitIds.has(c.id)}
                            onClick={() => setCloseTarget(c)}
                          />
                        </div>
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

      <Modal
        open={closeTarget != null}
        onClose={() => (closing ? undefined : setCloseTarget(null))}
        title="Close this visit?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCloseTarget(null)} disabled={closing}>
              Cancel
            </Button>
            <Button onClick={confirmClose} disabled={closing}>
              {closing ? "Closing…" : "Close visit"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Visit #{closeTarget?.visitNumber} for {closeTarget?.clientName} will be finalized and
          become read-only — measurements, notes and charges can&apos;t be edited afterwards.
        </p>
        <p className="mt-2 text-xs text-slate-400">
          Only do this when nothing else needs recording. To add anything first, use
          &ldquo;Continue&rdquo;.
        </p>
      </Modal>

      <RescheduleAppointmentModal
        appointment={rescheduleTarget}
        onClose={() => setRescheduleTarget(null)}
        onRescheduled={refetch}
      />
    </div>
  );
}

/**
 * The one "Close visit" affordance, shared by the not-closed panel and the day
 * table so the two can't drift. Disabled — never hidden — while the visit's
 * basket is still pending, so the doctor can see the close is coming and why it
 * isn't available yet (same rule and wording as the editor's footer button).
 */
function CloseVisitButton({ blocked, onClick }: { blocked: boolean; onClick: () => void }) {
  return (
    <Button
      size="sm"
      // The clinic's green (brand-600, same as "Schedule appointment"): this is
      // the affirmative end of the row next to the neutral outlined "Continue",
      // and it greys itself out via the shared disabled styling when blocked.
      variant="primary"
      disabled={blocked}
      title={
        blocked
          ? "Waiting for the secretary to settle this visit's basket."
          : "Finalize this visit — it becomes read-only."
      }
      // The rows navigate to the patient profile on click — keep this from doing both.
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <CheckCircle2 className="h-3.5 w-3.5" /> Close visit
    </Button>
  );
}
