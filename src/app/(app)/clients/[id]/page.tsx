"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CalendarPlus,
  CalendarX,
  ChevronLeft,
  CreditCard,
  FileText,
  Pencil,
  Phone,
  Stethoscope,
  Upload,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatCard } from "@/components/ui/StatCard";
import { FormRow, Select, Textarea, WeekdayDateInput } from "@/components/ui/Field";
import { Tabs } from "@/components/ui/Tabs";
import {
  AppointmentBadge,
  Badge,
} from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading } from "@/components/ui/States";
import { WeightTrendChart } from "@/components/charts/Charts";
import { MedicalHistoryTab } from "./MedicalHistoryTab";
import { BloodTestsTab } from "./BloodTestsTab";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { todayIso } from "@/lib/config";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_VALUES,
  VISIT_TYPE_LABELS,
  type Appointment,
  type Client,
  type ClientDebt,
  type PaymentMethod,
} from "@/lib/types";
import {
  age,
  bmiCategory,
  cn,
  defaultSlot,
  formatDate,
  formatMoney,
  formatTime,
  initials,
  timeSlots,
} from "@/lib/utils";

const SLOTS = timeSlots();

// A future, still-scheduled appointment can be cancelled from the profile.
// Same-day no-shows are handled on the Queue; this is for upcoming bookings the
// client calls ahead to cancel. Cancelling only sets status — it never deletes
// the row, so the appointment stays in history (matching No-show).
function isCancellable(a: Appointment): boolean {
  return a.status === "scheduled" && a.date >= todayIso();
}

export default function ClientProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const { toast } = useToast();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  // Front-desk cancellation of an upcoming appointment (confirm before acting).
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
  const [cancelSaving, setCancelSaving] = useState(false);
  // Collect (clear) / write off (void) a tracked debt.
  const [debtAction, setDebtAction] = useState<{ debt: ClientDebt; mode: "clear" | "void" } | null>(null);
  const [debtMethod, setDebtMethod] = useState<PaymentMethod>("cash");
  // Why the debt is being written off — mandatory for a void (mirrors the server).
  const [debtVoidReason, setDebtVoidReason] = useState("");
  const [debtSaving, setDebtSaving] = useState(false);
  const initialSlot = defaultSlot(todayIso());
  const [booking, setBooking] = useState({ date: initialSlot.date, time: initialSlot.time });
  // Post-check-in correction of clinical notes (dietitian/admin); personal
  // details are edited on the check-in form itself (see the Personal tab).
  const [editNotesOpen, setEditNotesOpen] = useState(false);
  const { data, loading, error, refetch } = useApi(() => api.getClient(params.id), [params.id]);
  const staff = useApi(() => api.listStaff());

  if (loading) return <Loading />;
  if (error || !data) {
    return (
      <div className="py-16 text-center text-slate-400">
        Client not found.{" "}
        <button onClick={() => router.push("/clients")} className="text-brand-700 underline">
          Back to clients
        </button>
      </div>
    );
  }

  const { client, consultations: consults, appointments: appts, payments: pays, sessionPlans, debts, debtTotal } = data;
  const outstandingDebts = debts.filter((d) => d.status === "outstanding").length;
  const isDietitian = user?.role === "dietitian" || user?.role === "admin";
  // Money is the secretary's (and admin's) domain — the dietitian never handles it.
  const canHandleMoney = user?.role === "secretary" || user?.role === "admin";
  // Writing off (voiding) a debt forgives money owed — admin only (enforced server-side).
  const canVoidDebt = user?.role === "admin";
  // Front desk manages the schedule: booking and cancelling appointments.
  const canManageAppointments = user?.role === "secretary" || user?.role === "admin";
  // Edit rights mirror who fills each field at check-in (enforced server-side):
  // demographics/contact are front-desk data, clinical notes are the dietitian's.
  const canEditDetails = user?.role === "secretary" || user?.role === "admin";
  const canEditClinical = isDietitian;
  // Headline package = the patient's most recent active bundle (if any).
  const cp =
    client.packages.find((p) => p.status === "active") ?? client.packages[0];
  const first = consults[0];
  const last = consults[consults.length - 1];
  // A visit already in progress for this client. The primary CTA continues it
  // rather than starting a second one (which would duplicate the visit); a
  // never-closed draft from an earlier day is caught here too.
  const openDraft = consults.find((c) => c.status === "open");

  // Machine treatment balances with sessions left (for the Overview summary).
  const machinePackages = client.packages.filter(
    (p) => p.status === "active" && p.machine && p.totalSessions - p.usedSessions > 0,
  );
  // Visits where blood collection was ordered, latest last.
  const bloodConsults = consults.filter((c) => c.bloodCollection);
  const latestBlood = bloodConsults[bloodConsults.length - 1];

  const tabs = [
    "Overview",
    "Personal",
    "Medical History",
    "Bundles",
    "Appointments",
    "Blood Tests",
    ...(isDietitian ? ["Consultations", "Measurements", "Progress"] : []),
    ...(canHandleMoney ? ["Payments"] : []),
    "Notes",
    "Files",
  ];

  const weightSeries = consults
    .filter((c) => c.weightKg)
    .map((c) => ({
      label: `V${c.visitNumber}`,
      weight: c.weightKg!,
      goal: c.goalWeightKg ?? last?.goalWeightKg ?? 65,
    }));

  // Progress summary (per-client; replaces the old global Progress page).
  const startW = first?.weightKg;
  const curW = last?.weightKg;
  const goalW = last?.goalWeightKg ?? first?.goalWeightKg;
  const totalChange = startW && curW ? curW - startW : undefined;
  const pctToGoal =
    startW && curW && goalW && startW !== goalW
      ? Math.round(((startW - curW) / (startW - goalW)) * 100)
      : undefined;

  async function submitDebtAction() {
    if (!debtAction) return;
    // Writing off money requires a typed reason — reject empty client-side so the
    // request is never sent (the server enforces the same rule).
    const reason = debtVoidReason.trim();
    if (debtAction.mode === "void" && !reason) {
      toast("A reason is required to write off a debt");
      return;
    }
    setDebtSaving(true);
    try {
      if (debtAction.mode === "clear") {
        await api.clearClientDebt(debtAction.debt.id, { method: debtMethod });
        toast("Debt collected — payment recorded");
      } else {
        await api.voidClientDebt(debtAction.debt.id, { reason });
        toast("Debt written off");
      }
      setDebtAction(null);
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setDebtSaving(false);
    }
  }

  async function scheduleAppointment() {
    setScheduleSaving(true);
    try {
      // Keep the client's assigned dietitian on the appointment (resolved by name).
      const dietitianId =
        (staff.data ?? []).find((s) => s.fullName === data!.client.assignedDietitian)?.id ?? null;
      await api.createAppointment({
        clientId: data!.client.id,
        dietitianId,
        date: booking.date,
        time: booking.time,
        visitType: "follow_up",
      });
      toast("Appointment scheduled");
      setScheduleOpen(false);
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setScheduleSaving(false);
    }
  }

  // Mark an upcoming appointment cancelled. Same pattern as the Queue's No-show
  // (reuses api.setAppointmentStatus); the two stay distinct statuses so staff
  // can tell "called to cancel" from "didn't show", but the backend treats them
  // identically (neither completes a visit, blocks a slot, or uses a credit).
  async function cancelAppointment() {
    if (!cancelTarget) return;
    setCancelSaving(true);
    try {
      await api.setAppointmentStatus(cancelTarget.id, "cancelled");
      toast("Appointment cancelled");
      setCancelTarget(null);
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setCancelSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => router.push("/clients")}
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" /> All clients
      </button>

      {/* Header */}
      <Card className="mb-6">
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-700">
              {initials(client.firstName, client.lastName)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-slate-900">
                  {client.firstName} {client.lastName}
                </h1>
                {client.active ? (
                  <Badge tone="green">Active</Badge>
                ) : (
                  client.inactive && <Badge tone="gray">Inactive</Badge>
                )}
                {!client.hasMedicalHistory && (
                  <Badge tone="amber">Medical history needs to be taken</Badge>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5" /> {client.phone}
                </span>
                {client.assignedDietitian && <span>· {client.assignedDietitian}</span>}
                {cp && <span>· {cp.usedSessions}/{cp.totalSessions} sessions</span>}
                {canHandleMoney && debtTotal > 0 && (
                  <span className="text-amber-600">· Debt {formatMoney(debtTotal, "USD")}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setScheduleOpen(true)}>
              <CalendarPlus className="h-4 w-4" /> Schedule
            </Button>
            {canHandleMoney && (
              <Button variant="outline" size="sm" onClick={() => router.push("/payments")}>
                <CreditCard className="h-4 w-4" /> Payment
              </Button>
            )}
            {isDietitian && (
              <Button
                size="sm"
                onClick={() =>
                  router.push(
                    openDraft
                      ? `/consultations/new?client=${client.id}&consultation=${openDraft.id}`
                      : `/consultations/new?client=${client.id}`,
                  )
                }
              >
                <Stethoscope className="h-4 w-4" />{" "}
                {openDraft ? "Continue consultation" : "Start consultation"}
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Tabs tabs={tabs}>
        {(active) => (
          <>
            {active === "Overview" && (
              <div className="grid gap-4 lg:grid-cols-3">
                <Card><CardBody>
                  <p className="text-xs uppercase text-slate-400">Active bundle</p>
                  <p className="mt-1 font-semibold text-slate-800">{cp?.packageName ?? "—"}</p>
                  {cp && (
                    <p className="mt-1 text-sm text-slate-500">
                      <span className="font-medium text-slate-700">{cp.usedSessions} done</span>
                      {" · "}
                      <span className="font-medium text-emerald-600">{cp.totalSessions - cp.usedSessions} left</span>
                      <span className="text-slate-400"> of {cp.totalSessions}</span>
                    </p>
                  )}
                </CardBody></Card>
                {isDietitian && (
                  <Card><CardBody>
                    <p className="text-xs uppercase text-slate-400">Weight progress</p>
                    {first?.weightKg && last?.weightKg ? (
                      <>
                        <p className="mt-1 font-semibold text-slate-800">
                          {first.weightKg} → {last.weightKg} kg
                        </p>
                        <p className={cn("mt-1 text-sm", last.weightKg - first.weightKg <= 0 ? "text-emerald-600" : "text-rose-600")}>
                          {(last.weightKg - first.weightKg).toFixed(1)} kg since start
                        </p>
                      </>
                    ) : <p className="mt-1 text-sm text-slate-400">No measurements yet</p>}
                  </CardBody></Card>
                )}
                {canHandleMoney && (
                  <Card>
                    <CardBody>
                      <p className="text-xs uppercase text-slate-400">
                        {debtTotal > 0 ? "Outstanding debt" : "No outstanding debt"}
                      </p>
                      <p className={cn("mt-1 font-semibold", debtTotal > 0 ? "text-amber-600" : "text-emerald-600")}>
                        {formatMoney(debtTotal, "USD")}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {debtTotal > 0
                          ? `${outstandingDebts} tracked debt${outstandingDebts !== 1 ? "s" : ""} — see Payments`
                          : "Nothing owed"}
                      </p>
                    </CardBody>
                  </Card>
                )}
                {isDietitian && (
                  <Card><CardBody>
                    <p className="text-xs uppercase text-slate-400">Blood test</p>
                    {bloodConsults.length > 0 ? (
                      <>
                        <p className="mt-1 font-semibold text-emerald-600">
                          Done · {bloodConsults.length} time{bloodConsults.length !== 1 ? "s" : ""}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          Last on {formatDate(latestBlood.date)}
                          {bloodTestsWithPrices(latestBlood)
                            ? ` · ${bloodTestsWithPrices(latestBlood)}`
                            : ""}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-sm text-slate-400">No blood test on record</p>
                    )}
                  </CardBody></Card>
                )}
                {machinePackages.length > 0 && (
                  <Card><CardBody>
                    <p className="text-xs uppercase text-slate-400">Treatment sessions</p>
                    <ul className="mt-1 space-y-1 text-sm text-slate-600">
                      {machinePackages.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-700">{p.machine}</span>
                          <span className="text-slate-500">
                            {p.usedSessions} done · {p.totalSessions - p.usedSessions} left
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardBody></Card>
                )}
                {isDietitian && weightSeries.length > 1 && (
                  <Card className="lg:col-span-3">
                    <CardHeader title="Weight trend" subtitle="Across consultations vs goal" />
                    <CardBody><WeightTrendChart data={weightSeries} /></CardBody>
                  </Card>
                )}
              </div>
            )}

            {active === "Personal" && (
              <Card>
                <CardHeader
                  title="Personal details"
                  subtitle="Captured at registration and check-in"
                  action={
                    canEditDetails ? (
                      // Reuses the check-in form, pre-filled with the current
                      // details, in its post-check-in "edit" mode.
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          router.push(`/clients/${client.id}/checkin?return=/clients/${client.id}`)
                        }
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                    ) : undefined
                  }
                />
                <CardBody>
                <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                  <Info label="Full name" value={`${client.firstName} ${client.lastName}`} />
                  <Info label="Phone" value={client.phone} />
                  <Info label="Email" value={client.email ?? "—"} />
                  <Info label="Age" value={age(client.dateOfBirth) ? `${age(client.dateOfBirth)} yrs` : "—"} />
                  <Info label="Gender" value={client.gender ?? "—"} />
                  <Info label="Marital status" value={client.maritalStatus ?? "—"} />
                  <Info label="Passport / ID" value={client.passportNumber ?? "—"} />
                  <Info label="Country" value={client.country ?? "—"} />
                  <Info label="Referrer" value={client.referralSource ?? "—"} />
                  <Info label="First-time patient" value={client.firstTimePatient ? "Yes" : "No"} />
                  <Info label="Address" value={client.address ?? "—"} />
                  <Info label="Emergency contact" value={client.emergencyContact ?? "—"} />
                  <Info label="Registered" value={formatDate(client.registeredAt)} />
                  {isDietitian && <Info label="Medical notes" value={client.medicalNotes ?? "—"} />}
                  {isDietitian && <Info label="Allergies" value={client.allergies ?? "—"} />}
                </dl>
                </CardBody>
              </Card>
            )}

            {active === "Medical History" &&
              (isDietitian ? (
                <MedicalHistoryTab clientId={client.id} />
              ) : (
                <Card><CardBody>
                  <p className="text-sm text-slate-500">
                    Medical history is restricted to the dietitian and admin.
                  </p>
                </CardBody></Card>
              ))}

            {active === "Bundles" && (
              <div className="space-y-6">
                <Card>
                  <CardHeader title="Bundles" subtitle="Prepaid treatment bundles and session usage" />
                  <Table>
                    <THead><TR>
                      <TH>Bundle</TH><TH>Treatment</TH><TH>Price</TH><TH>Sessions</TH><TH>Start</TH><TH>Status</TH>
                    </TR></THead>
                    <TBody>
                      {client.packages.map((p) => (
                        <TR key={p.id}>
                          <TD className="font-medium">{p.packageName}</TD>
                          <TD className="text-slate-500">{p.machine ?? "—"}</TD>
                          <TD>{formatMoney(p.price, p.currency)}</TD>
                          <TD>{p.usedSessions}/{p.totalSessions}</TD>
                          <TD className="text-slate-500">{formatDate(p.startDate)}</TD>
                          <TD><Badge tone={p.status === "active" ? "green" : "gray"}>{p.status}</Badge></TD>
                        </TR>
                      ))}
                      {client.packages.length === 0 && (
                        <TR><TD colSpan={6} className="py-6 text-center text-slate-400">No bundles.</TD></TR>
                      )}
                    </TBody>
                  </Table>
                </Card>

                <Card>
                  <CardHeader
                    title="Session plans"
                    subtitle="Pay-as-you-go sessions — paid per visit, with prepaid credit carried forward"
                  />
                  {sessionPlans.length === 0 ? (
                    <CardBody className="text-sm text-slate-400">No session plans.</CardBody>
                  ) : (
                    <Table>
                      <THead><TR>
                        <TH>Treatment</TH><TH>Unit price</TH><TH>Needed</TH><TH>Used</TH><TH>Paid</TH><TH>Credit</TH><TH>Left to attend</TH><TH>Status</TH>
                      </TR></THead>
                      <TBody>
                        {sessionPlans.map((p) => (
                          <TR key={p.id}>
                            <TD className="font-medium">{p.machine ?? "General"}</TD>
                            <TD>{formatMoney(p.unitPrice, p.currency)}</TD>
                            <TD>{p.sessionsNeeded}</TD>
                            <TD>{p.sessionsUsed}</TD>
                            <TD>{p.sessionsPaid}</TD>
                            <TD>
                              <span className={p.credit > 0 ? "font-medium text-emerald-600" : "text-slate-500"}>
                                {p.credit}
                              </span>
                            </TD>
                            <TD>{p.sessionsLeftToAttend}</TD>
                            <TD><Badge tone={p.status === "active" ? "green" : p.status === "completed" ? "gray" : "red"}>{p.status}</Badge></TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </Card>
              </div>
            )}

            {active === "Appointments" && (
              <Card>
                <Table>
                  <THead><TR><TH>Date</TH><TH>Time</TH><TH>Visit</TH><TH>Dietitian</TH><TH>Status</TH>{canManageAppointments && <TH>Actions</TH>}</TR></THead>
                  <TBody>
                    {appts.map((a) => (
                      <TR key={a.id}>
                        <TD>{formatDate(a.date)}</TD>
                        <TD>{formatTime(a.time)}</TD>
                        <TD className="text-slate-500">{VISIT_TYPE_LABELS[a.visitType] ?? a.visitType}</TD>
                        <TD className="text-slate-500">{a.dietitianName}</TD>
                        <TD><AppointmentBadge status={a.status} /></TD>
                        {canManageAppointments && (
                          <TD>
                            {isCancellable(a) && (
                              <Button size="sm" variant="danger" onClick={() => setCancelTarget(a)}>
                                <CalendarX className="h-3.5 w-3.5" /> Cancel
                              </Button>
                            )}
                          </TD>
                        )}
                      </TR>
                    ))}
                    {appts.length === 0 && <TR><TD colSpan={canManageAppointments ? 6 : 5} className="py-6 text-center text-slate-400">No appointments.</TD></TR>}
                  </TBody>
                </Table>
              </Card>
            )}

            {active === "Blood Tests" && <BloodTestsTab clientId={client.id} />}

            {active === "Consultations" && isDietitian && (
              <div className="space-y-3">
                {consults.length === 0 && <p className="text-sm text-slate-400">No consultations yet.</p>}
                {[...consults].reverse().map((c) => (
                  <Card key={c.id}>
                    <CardBody>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="flex items-center gap-2 font-medium text-slate-800">
                            Visit #{c.visitNumber} · {formatDate(c.date)}
                            {c.status === "open" ? (
                              <Badge tone="amber">In progress</Badge>
                            ) : (
                              <Badge tone="gray">Closed</Badge>
                            )}
                          </p>
                          <p className="text-xs text-slate-500">{c.dietitianName}</p>
                        </div>
                        <div className="flex items-center gap-3 text-right text-sm">
                          <div>
                            {c.weightKg && <span className="font-medium text-slate-700">{c.weightKg} kg</span>}
                            {c.bmi && <span className="ml-2 text-slate-400">BMI {c.bmi}</span>}
                          </div>
                          {c.status === "open" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/consultations/new?client=${client.id}&consultation=${c.id}`)}
                            >
                              Continue
                            </Button>
                          )}
                        </div>
                      </div>
                      {c.notes && <p className="mt-3 text-sm text-slate-600"><span className="font-medium text-slate-700">Notes: </span>{c.notes}</p>}
                      {c.recommendations && <p className="mt-1 text-sm text-slate-600"><span className="font-medium text-slate-700">Recommendations: </span>{c.recommendations}</p>}
                      {(c.bloodCollection ||
                        c.nurseRequired ||
                        (c.treatments && c.treatments.length > 0) ||
                        (c.products && c.products.length > 0)) && (
                        <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-sm text-slate-600">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Visit services</p>
                          {c.bloodCollection && (
                            <p><span className="font-medium text-slate-700">Blood tests: </span>{bloodTestsWithPrices(c) || "Requested"}</p>
                          )}
                          {c.nurseRequired && (
                            <p>
                              <span className="font-medium text-slate-700">Nurse: </span>
                              Required
                            </p>
                          )}
                          {c.treatments?.map((t) => (
                            <p key={t.id}>
                              <span className="font-medium text-slate-700">{t.machineOther || t.machine}: </span>
                              {t.bodyParts.length > 0 ? t.bodyParts.join(", ") : "—"}
                              {t.price !== undefined && t.price > 0 && (
                                <span className="text-slate-400"> · {formatMoney(t.price, t.currency)}</span>
                              )}
                              <span className="text-slate-400"> · {t.sessionsUsed} session{t.sessionsUsed !== 1 ? "s" : ""} used{t.packageName ? ` (${t.packageName})` : t.sessionPlanId ? " (session plan)" : ""}</span>
                            </p>
                          ))}
                          {c.products?.map((p) => (
                            <p key={p.id}>
                              <span className="font-medium text-slate-700">Product: </span>
                              {p.name} ×{p.quantity}{p.amount ? ` · ${formatMoney(p.amount)}` : ""}
                            </p>
                          ))}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}

            {active === "Measurements" && isDietitian && (
              <Card>
                <Table>
                  <THead><TR>
                    <TH>Visit</TH><TH>Date</TH><TH>Weight</TH><TH>BMI</TH><TH>Category</TH><TH>Waist</TH><TH>Body fat</TH>
                  </TR></THead>
                  <TBody>
                    {consults.map((c) => (
                      <TR key={c.id}>
                        <TD className="font-medium">#{c.visitNumber}</TD>
                        <TD className="text-slate-500">{formatDate(c.date)}</TD>
                        <TD>{c.weightKg ? `${c.weightKg} kg` : "—"}</TD>
                        <TD>{c.bmi ?? "—"}</TD>
                        <TD className="text-slate-500">{bmiCategory(c.bmi)}</TD>
                        <TD>{c.waistCm ? `${c.waistCm} cm` : "—"}</TD>
                        <TD>{c.bodyFatPercent ? `${c.bodyFatPercent}%` : "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
            )}

            {active === "Progress" && isDietitian && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatCard label="Starting weight" value={startW ? `${startW} kg` : "—"} tone="slate" />
                  <StatCard label="Current weight" value={curW ? `${curW} kg` : "—"} tone="brand" />
                  <StatCard
                    label="Total change"
                    value={totalChange !== undefined ? `${totalChange > 0 ? "+" : ""}${totalChange.toFixed(1)} kg` : "—"}
                    tone={totalChange !== undefined && totalChange <= 0 ? "green" : "rose"}
                  />
                  <StatCard label="Progress to goal" value={pctToGoal !== undefined ? `${pctToGoal}%` : "—"} tone="blue" />
                </div>

                <Card>
                  <CardHeader title="Weight trend" subtitle="Across all consultations vs goal weight" />
                  <CardBody>
                    {weightSeries.length > 1 ? (
                      <WeightTrendChart data={weightSeries} />
                    ) : (
                      <p className="py-8 text-center text-sm text-slate-400">
                        Not enough measurements to chart a trend yet.
                      </p>
                    )}
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader title="Consultation timeline" />
                  <CardBody>
                    {consults.length === 0 ? (
                      <p className="py-6 text-center text-sm text-slate-400">No consultations yet.</p>
                    ) : (
                      <ol className="relative border-l border-slate-200 pl-6">
                        {[...consults].reverse().map((c) => (
                          <li key={c.id} className="mb-6 last:mb-0">
                            <span className="absolute -left-[7px] mt-1 h-3 w-3 rounded-full bg-brand-500" />
                            <p className="text-sm font-medium text-slate-800">
                              Visit #{c.visitNumber} · {c.weightKg ?? "—"} kg
                            </p>
                            <p className="text-xs text-slate-500">{formatDate(c.date)} · {c.dietitianName}</p>
                            {c.notes && <p className="mt-1 text-sm text-slate-600">{c.notes}</p>}
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardBody>
                </Card>
              </div>
            )}

            {active === "Payments" && canHandleMoney && (
              <div className="space-y-6">
                <Card>
                  <Table>
                    <THead><TR><TH>Receipt</TH><TH>Motif</TH><TH>Amount</TH><TH>Method</TH><TH>Date</TH></TR></THead>
                    <TBody>
                      {pays.map((p) => (
                        <TR key={p.id}>
                          <TD className="font-mono text-xs">{p.receiptNumber}</TD>
                          <TD>{p.motif}</TD>
                          <TD className="font-medium">{formatMoney(p.amountPaid, p.currency)}</TD>
                          <TD className="capitalize text-slate-500">{p.method.replace("_", " ")}</TD>
                          <TD className="text-slate-500">{formatDate(p.date)}</TD>
                        </TR>
                      ))}
                      {pays.length === 0 && <TR><TD colSpan={5} className="py-6 text-center text-slate-400">No payments.</TD></TR>}
                    </TBody>
                  </Table>
                </Card>

                <Card>
                  <CardHeader
                    title="Tracked debts"
                    subtitle="Money owed but not collected — from a closed visit or a settlement override. Collecting records a payment; voiding writes it off."
                  />
                  {debts.length === 0 ? (
                    <CardBody className="text-sm text-slate-400">No debts on record.</CardBody>
                  ) : (
                    <Table>
                      <THead><TR>
                        <TH>Date</TH><TH>Visit</TH><TH>Reason</TH><TH>Amount</TH><TH>Status</TH><TH></TH>
                      </TR></THead>
                      <TBody>
                        {debts.map((d) => (
                          <TR key={d.id}>
                            <TD className="text-slate-500">{formatDate(d.createdAt)}</TD>
                            <TD className="text-slate-500">{d.visitNumber ? `#${d.visitNumber}` : "—"}</TD>
                            <TD>{d.reason}</TD>
                            <TD className="font-medium">{formatMoney(d.amount, d.currency)}</TD>
                            <TD>
                              <Badge tone={d.status === "outstanding" ? "amber" : d.status === "cleared" ? "green" : "gray"}>
                                {d.status === "outstanding" ? "Outstanding" : d.status === "cleared" ? "Collected" : "Written off"}
                              </Badge>
                            </TD>
                            <TD className="text-right">
                              {d.status === "outstanding" && (
                                <div className="flex justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setDebtMethod("cash");
                                      setDebtAction({ debt: d, mode: "clear" });
                                    }}
                                  >
                                    Collect
                                  </Button>
                                  {canVoidDebt && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        setDebtVoidReason("");
                                        setDebtAction({ debt: d, mode: "void" });
                                      }}
                                    >
                                      Void
                                    </Button>
                                  )}
                                </div>
                              )}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                  {debtTotal > 0 && (
                    <CardBody className="flex items-center justify-between border-t border-slate-100 text-sm">
                      <span className="font-medium text-slate-700">Total outstanding debt</span>
                      <span className="font-semibold text-amber-600">{formatMoney(debtTotal, "USD")}</span>
                    </CardBody>
                  )}
                </Card>
              </div>
            )}

            {active === "Notes" && (
              <Card>
                {canEditClinical && (
                  <CardHeader
                    title="Clinical notes"
                    subtitle="Medical notes and allergies — dietitian and admin only"
                    action={
                      <Button size="sm" variant="outline" onClick={() => setEditNotesOpen(true)}>
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                    }
                  />
                )}
                <CardBody className="space-y-4">
                {isDietitian ? (
                  <>
                    <div>
                      <p className="text-xs uppercase text-slate-400">Medical notes</p>
                      <p className="mt-1 text-sm text-slate-600">{client.medicalNotes ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase text-slate-400">Allergies / restrictions</p>
                      <p className="mt-1 text-sm text-slate-600">{client.allergies ?? "—"}</p>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">
                    Clinical notes are restricted to the dietitian and admin.
                  </p>
                )}
                </CardBody>
              </Card>
            )}

            {active === "Files" && (
              <Card>
                <CardHeader
                  title="Files"
                  subtitle="Lab results, meal plans and documents"
                  action={
                    <Button size="sm" variant="outline" onClick={() => toast("File uploads arrive in Version 4")}>
                      <Upload className="h-4 w-4" /> Upload
                    </Button>
                  }
                />
                <CardBody>
                  {isDietitian ? (
                    <ul className="divide-y divide-slate-100">
                      {[
                        { name: "Meal-plan-week1.pdf", size: "184 KB", date: client.registeredAt },
                        { name: "Blood-panel.pdf", size: "512 KB", date: client.registeredAt },
                      ].map((f) => (
                        <li key={f.name} className="flex items-center justify-between py-3">
                          <span className="flex items-center gap-3">
                            <FileText className="h-5 w-5 text-slate-400" />
                            <span>
                              <span className="block text-sm font-medium text-slate-700">{f.name}</span>
                              <span className="block text-xs text-slate-400">
                                {f.size} · {formatDate(f.date)}
                              </span>
                            </span>
                          </span>
                          <Button size="sm" variant="ghost" onClick={() => toast("File downloads arrive in Version 4")}>Download</Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-500">
                      Client files are restricted to the dietitian and admin.
                    </p>
                  )}
                </CardBody>
              </Card>
            )}
          </>
        )}
      </Tabs>

      <Modal
        open={Boolean(debtAction)}
        onClose={() => setDebtAction(null)}
        title={debtAction?.mode === "clear" ? "Collect debt" : "Write off debt"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDebtAction(null)} disabled={debtSaving}>
              Cancel
            </Button>
            <Button
              variant={debtAction?.mode === "void" ? "outline" : "primary"}
              onClick={submitDebtAction}
              disabled={debtSaving}
            >
              {debtSaving
                ? "Saving…"
                : debtAction?.mode === "clear"
                  ? "Record payment"
                  : "Write off"}
            </Button>
          </>
        }
      >
        {debtAction && (
          <div className="space-y-3 text-sm text-slate-600">
            <p>
              {debtAction.mode === "clear" ? (
                <>
                  Collect <span className="font-semibold text-slate-800">{formatMoney(debtAction.debt.amount, debtAction.debt.currency)}</span>{" "}
                  for “{debtAction.debt.reason}”. This records a payment and clears the debt.
                </>
              ) : (
                <>
                  Write off <span className="font-semibold text-slate-800">{formatMoney(debtAction.debt.amount, debtAction.debt.currency)}</span>{" "}
                  for “{debtAction.debt.reason}”. No payment is recorded — the debt is forgiven and closed.
                </>
              )}
            </p>
            {debtAction.mode === "clear" && (
              <FormRow label="Payment method">
                <Select value={debtMethod} onChange={(e) => setDebtMethod(e.target.value as PaymentMethod)}>
                  {PAYMENT_METHOD_VALUES.map((m) => (
                    <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                  ))}
                </Select>
              </FormRow>
            )}
            {debtAction.mode === "void" && (
              <FormRow label="Reason for writing off">
                <Textarea
                  rows={2}
                  value={debtVoidReason}
                  onChange={(e) => setDebtVoidReason(e.target.value)}
                  placeholder="Why is this debt being forgiven? (recorded in the audit log)"
                />
              </FormRow>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title={`Schedule appointment — ${client.firstName} ${client.lastName}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button>
            <Button onClick={scheduleAppointment} disabled={scheduleSaving}>
              {scheduleSaving ? "Saving…" : "Schedule"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow label="Date">
            <WeekdayDateInput min={todayIso()} value={booking.date} onChange={(v) => setBooking({ ...booking, date: v })} />
          </FormRow>
          <FormRow label="Time slot">
            <Select value={booking.time} onChange={(e) => setBooking({ ...booking, time: e.target.value })}>
              {SLOTS.map((t) => <option key={t} value={t}>{formatTime(t)}</option>)}
            </Select>
          </FormRow>
        </div>
      </Modal>

      <Modal
        open={cancelTarget != null}
        onClose={() => setCancelTarget(null)}
        title="Cancel appointment"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelTarget(null)}>Keep appointment</Button>
            <Button variant="danger" onClick={cancelAppointment} disabled={cancelSaving}>
              {cancelSaving ? "Cancelling…" : "Cancel appointment"}
            </Button>
          </>
        }
      >
        {cancelTarget && (
          <p className="text-sm text-slate-600">
            Cancel {client.firstName} {client.lastName}&rsquo;s appointment on{" "}
            <span className="font-medium text-slate-800">{formatDate(cancelTarget.date)}</span> at{" "}
            <span className="font-medium text-slate-800">{formatTime(cancelTarget.time)}</span>? It stays
            in the appointment history marked <span className="font-medium">Cancelled</span>.
          </p>
        )}
      </Modal>

      {canEditClinical && (
        <EditClinicalNotesModal
          client={client}
          open={editNotesOpen}
          onClose={() => setEditNotesOpen(false)}
          onSaved={() => {
            setEditNotesOpen(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

/**
 * Dietitian/admin correction of the clinical fields on the patient record.
 * Kept separate from the personal-details edit (the check-in form) because
 * after check-in the server allows these two fields only for clinical roles
 * (and the rest only for the front desk).
 */
function EditClinicalNotesModal({
  client,
  open,
  onClose,
  onSaved,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({ medicalNotes: "", allergies: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ medicalNotes: client.medicalNotes ?? "", allergies: client.allergies ?? "" });
    }
  }, [open, client]);

  async function save() {
    setSaving(true);
    try {
      // Blank values are sent so clearing a note sticks.
      await api.updateClient(client.id, {
        medicalNotes: form.medicalNotes.trim(),
        allergies: form.allergies.trim(),
      });
      toast("Clinical notes updated");
      onSaved();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Clinical notes — ${client.firstName} ${client.lastName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormRow label="Medical notes">
          <Textarea rows={3} value={form.medicalNotes} onChange={(e) => setForm((f) => ({ ...f, medicalNotes: e.target.value }))} placeholder="Conditions, medication…" />
        </FormRow>
        <FormRow label="Allergies / restrictions">
          <Textarea rows={2} value={form.allergies} onChange={(e) => setForm((f) => ({ ...f, allergies: e.target.value }))} placeholder="e.g. lactose intolerant" />
        </FormRow>
      </div>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm capitalize text-slate-700">{value}</dd>
    </div>
  );
}

function bloodTestsWithPrices(c: {
  bloodTests?: string[];
  bloodTestCharges?: { name: string; price: number; currency?: string }[];
}) {
  if (c.bloodTestCharges && c.bloodTestCharges.length > 0) {
    return c.bloodTestCharges
      .map((test) => `${test.name} (${formatMoney(test.price, test.currency)})`)
      .join(", ");
  }
  return c.bloodTests && c.bloodTests.length > 0 ? c.bloodTests.join(", ") : "";
}
