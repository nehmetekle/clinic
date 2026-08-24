"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  CalendarClock,
  CalendarPlus,
  CalendarX,
  ChevronLeft,
  Pencil,
  Phone,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatCard } from "@/components/ui/StatCard";
import { FormRow, Input, Label, MoneyInput, Select, Textarea } from "@/components/ui/Field";
import {
  isReschedulable,
  RescheduleAppointmentModal,
  ScheduleAppointmentModal,
} from "@/components/ScheduleAppointmentModal";
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
import { FilesTab } from "./FilesTab";
import { MachineVisitCard } from "./MachineVisitCard";
import { LogMachineVisitModal } from "@/components/LogMachineVisitModal";
import { SellSessionsModal } from "@/components/SellSessionsModal";
import { VisitBasketSettlementModal } from "@/components/VisitBasketSettlementModal";
import { VisitSummaryModal } from "./VisitSummaryModal";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import {
  JESSY_METHOD,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_VALUES,
  VISIT_TYPE_LABELS,
  type Appointment,
  type Client,
  type ClientDebt,
  type MachineVisit,
  type PaymentMethod,
} from "@/lib/types";
import { NO_MACHINE_LABEL } from "@/lib/types";
import {
  age,
  cardSurchargeAmount,
  cn,
  formatDate,
  formatMoney,
  formatTime,
  initials,
  parseNumberInput,
} from "@/lib/utils";
import { CLINIC } from "@/lib/config";
import {
  TENDER_CURRENCY_LABELS,
  TENDER_CURRENCY_VALUES,
  formatFxRate,
  formatTender,
  formatUsd,
  fxRateFor,
  tenderToUsd,
  usdToTender,
  type TenderCurrency,
} from "@/lib/money";

// A future, still-scheduled appointment can be cancelled from the profile.
// Same-day no-shows are handled on the Queue; this is for upcoming bookings the
// client calls ahead to cancel. Cancelling only sets status — it never deletes
// the row, so the appointment stays in history (matching No-show).
// Same window as rescheduling — an upcoming, untouched booking. A slot that has
// already been checked in, seen or passed is history either way.
const isCancellable = isReschedulable;

export default function ClientProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  // Set when the profile was opened from the queue for a specific booking; passed
  // on to the consultation editor so the visit records which appointment it is
  // fulfilling (see completeLinkedAppointmentTx).
  const searchParams = useSearchParams();
  const apptParam = searchParams.get("appt") ? `&appt=${searchParams.get("appt")}` : "";
  const { user } = useSession();
  const { toast } = useToast();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Front-desk cancellation of an upcoming appointment (confirm before acting).
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
  const [cancelSaving, setCancelSaving] = useState(false);
  // Front-desk move of an upcoming appointment to a new slot.
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  // Collect (clear) / write off (void) a tracked debt.
  const [debtAction, setDebtAction] = useState<{ debt: ClientDebt; mode: "clear" | "void" } | null>(null);
  const [debtMethod, setDebtMethod] = useState<PaymentMethod>("cash");
  // The debt is a USD obligation; this is only the currency it is TENDERED in.
  const [debtCurrency, setDebtCurrency] = useState<TenderCurrency>("USD");
  // Native amount handed over. Blank = collect the whole outstanding balance (the
  // original behaviour). Foreign tender rarely lands on the exact balance, so a
  // shortfall is recorded as a PARTIAL payment rather than being refused.
  const [debtTenderAmount, setDebtTenderAmount] = useState("");
  // Why the debt is being written off — mandatory for a void (mirrors the server).
  const [debtVoidReason, setDebtVoidReason] = useState("");
  const [debtSaving, setDebtSaving] = useState(false);
  // Post-check-in correction of clinical notes (dietitian/admin); personal
  // details are edited on the check-in form itself (see the Personal tab).
  const [editNotesOpen, setEditNotesOpen] = useState(false);
  // The closed visit whose read-only summary is open. Held by id (not by object)
  // so a refetch can't leave the modal showing a stale copy of the visit.
  const [summaryVisitId, setSummaryVisitId] = useState<string | null>(null);
  // Machine-only visits (prepaid sessions used without a consultation). Merged
  // into the visit history below; kept as its own fetch so logging one refreshes
  // the list without reloading the whole profile.
  const machineVisits = useApi(() => api.listMachineVisits({ clientId: params.id }), [params.id]);
  // The "Log machine visit" dialog, and which treatment row opened it (ticked on
  // open so the common one-machine case is a two-click flow).
  const [machineVisitOpen, setMachineVisitOpen] = useState(false);
  const [machineVisitPreselect, setMachineVisitPreselect] = useState<string | undefined>();
  // Front-desk session sale. It only raises a basket; the secretary settles it in
  // the normal checkout, and that is what makes the sessions usable.
  const [sellSessionsOpen, setSellSessionsOpen] = useState(false);
  // The client's unsettled baskets, settleable from the Payments tab. The queue
  // board's Payment lane only carries TODAY's baskets, so it cannot be the only
  // way in: a sale made yesterday and not settled would otherwise be unreachable
  // — the money uncollectable and the sessions never unlocked.
  const pendingBaskets = useApi(
    () => api.listVisitBaskets({ status: "pending", clientId: params.id }),
    [params.id],
  );
  const productCatalog = useApi(() => api.listProducts());
  const [openBasketId, setOpenBasketId] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<MachineVisit | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidSaving, setVoidSaving] = useState(false);
  const { data, loading, error, refetch } = useApi(() => api.getClient(params.id), [params.id]);
  const staff = useApi(() => api.listStaff());
  const settings = useApi(() => api.getSettings());

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
  // A plain doctor (dietitian, not admin) gets a narrowed personal-details view:
  // only name, gender, referrer, age and first-time status.
  const isDoctorLimitedView = user?.role === "dietitian";
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
  // Logging a machine-only visit is the clinical side's call (server: canLogMachineVisit).
  const canLogMachineVisit = user?.role === "dietitian" || user?.role === "admin";
  const machineVisitList = machineVisits.data ?? [];
  // One history stream: consultations and machine visits by date, newest first.
  // Merged for DISPLAY only — consultation numbering is untouched.
  const visitTimeline: (
    | { kind: "consultation"; date: string; consultation: (typeof consults)[number] }
    | { kind: "machine"; date: string; visit: MachineVisit }
  )[] = [
    ...consults.map((c) => ({ kind: "consultation" as const, date: c.date, consultation: c })),
    ...machineVisitList.map((v) => ({ kind: "machine" as const, date: v.date, visit: v })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  async function voidMachineVisit() {
    if (!voidTarget) return;
    setVoidSaving(true);
    try {
      await api.voidMachineVisit(voidTarget.id, { reason: voidReason.trim() || undefined });
      setVoidTarget(null);
      setVoidReason("");
      machineVisits.refetch();
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setVoidSaving(false);
    }
  }
  // Headline package = the patient's most recent active bundle (if any).
  const cp =
    client.packages.find((p) => p.status === "active") ?? client.packages[0];
  const first = consults[0];
  const last = consults[consults.length - 1];
  // A visit already in progress for this client. The primary CTA continues it
  // rather than starting a second one (which would duplicate the visit); a
  // never-closed draft from an earlier day is caught here too.
  // Only a draft this user may actually work on: a dietitian can edit/close their
  // own visit (or an unowned one), never another doctor's — the server enforces
  // the same rule, so offering "Continue" on someone else's would only 403.
  const openDraft = consults.find(
    (c) =>
      c.status === "open" &&
      (user?.role === "admin" || !c.dietitianId || c.dietitianId === user?.id),
  );

  // Machine treatment balances with sessions left (for the Overview summary).
  const machinePackages = client.packages.filter(
    (p) => p.status === "active" && p.machine && p.totalSessions - p.usedSessions > 0,
  );
  // Plans with bought-and-settled sessions left. Bundle sessions left and plan
  // availability are both "already paid for" from the patient's point of view, so
  // the Overview headline adds them up.
  const creditPlans = sessionPlans.filter((p) => p.status === "active" && p.sessionsAvailable > 0);
  const prepaidSessions =
    machinePackages.reduce((n, p) => n + (p.totalSessions - p.usedSessions), 0) +
    creditPlans.reduce((n, p) => n + p.sessionsAvailable, 0);
  // Visits where blood collection was ordered, latest last.
  const bloodConsults = consults.filter((c) => c.bloodCollection);
  const latestBlood = bloodConsults[bloodConsults.length - 1];

  const tabs = [
    "Overview",
    "Personal",
    // Medical history and clinical notes are the doctor's/admin's — the
    // secretary doesn't get these tabs at all (not just a locked message).
    ...(isDietitian ? ["Medical History"] : []),
    "Treatments",
    "Appointments",
    "Blood Tests",
    ...(isDietitian ? ["Visits", "Progress"] : []),
    ...(canHandleMoney ? ["Payments"] : []),
    ...(isDietitian ? ["Notes"] : []),
    // Files is open to the secretary too — she hands the generated Food List PDF
    // to the patient. The tab itself scopes what she sees: consultation documents
    // only, never blood-test lab results (those stay clinical, enforced server-side).
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
        const native = parseNumberInput(debtTenderAmount);
        await api.clearClientDebt(debtAction.debt.id, {
          method: debtMethod,
          // Omitted when the desk didn't override the amount/currency, so the
          // server takes its original "clear the full balance in USD" path.
          ...(debtCurrency !== "USD" || native > 0
            ? { tender: [{ method: debtMethod, currency: debtCurrency, amount: native }] }
            : {}),
        });
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
                {client.phone && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="h-3.5 w-3.5" /> {client.phone}
                  </span>
                )}
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
            {canLogMachineVisit && (
              <Button
                size="sm"
                // Deliberately not the brand colour: this sits beside "Continue
                // consultation" and must not read as the same action.
                className="bg-indigo-600 text-white shadow-sm hover:bg-indigo-700"
                onClick={() => {
                  setMachineVisitPreselect(undefined);
                  setMachineVisitOpen(true);
                }}
              >
                <Sparkles className="h-4 w-4" /> Log machine visit
              </Button>
            )}
            {isDietitian && (
              <Button
                size="sm"
                onClick={() =>
                  router.push(
                    openDraft
                      ? `/consultations/new?client=${client.id}&consultation=${openDraft.id}${apptParam}`
                      : `/consultations/new?client=${client.id}${apptParam}`,
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
                  <p className="text-xs uppercase text-slate-400">
                    {cp ? "Active bundle" : "Prepaid sessions"}
                  </p>
                  <p className="mt-1 font-semibold text-slate-800">
                    {cp?.packageName ??
                      (prepaidSessions > 0
                        ? `${prepaidSessions} session${prepaidSessions !== 1 ? "s" : ""} prepaid`
                        : "—")}
                  </p>
                  {cp && (
                    <p className="mt-1 text-sm text-slate-500">
                      <span className="font-medium text-slate-700">{cp.usedSessions} done</span>
                      {" · "}
                      <span className="font-medium text-emerald-600">{cp.totalSessions - cp.usedSessions} left</span>
                      <span className="text-slate-400"> of {cp.totalSessions}</span>
                    </p>
                  )}
                  {creditPlans.length > 0 && (
                    <ul className="mt-2 space-y-1 text-sm text-slate-600">
                      {creditPlans.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-700">{p.machine ?? NO_MACHINE_LABEL}</span>
                          <span className="font-medium text-emerald-600">{p.sessionsAvailable} available</span>
                        </li>
                      ))}
                    </ul>
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
                  {/* A doctor (dietitian) sees a deliberately narrowed set of
                      personal fields — full name, gender, referrer, age and
                      first-time status. The remaining registration details are
                      not shown to that role (and the layout is kept complete so
                      it doesn't read as if data is missing). Admin/secretary see
                      the full record. */}
                  {isDoctorLimitedView ? (
                    <>
                      <Info label="Full name" value={`${client.firstName} ${client.lastName}`} />
                      <Info label="Age" value={age(client.dateOfBirth) ? `${age(client.dateOfBirth)} yrs` : "—"} />
                      <Info label="Gender" value={client.gender ?? "—"} />
                      <Info label="First-time patient" value={client.firstTimePatient ? "Yes" : "No"} />
                      <Info label="Referrer" value={client.referralSource ?? "—"} />
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </dl>
                </CardBody>
              </Card>
            )}

            {active === "Medical History" && isDietitian && (
              <MedicalHistoryTab clientId={client.id} />
            )}

            {active === "Treatments" && (
              <div className="space-y-6">
                {canHandleMoney && (
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setSellSessionsOpen(true)}>
                      Sell sessions
                    </Button>
                  </div>
                )}
                <Card>
                  <CardHeader title="Bundles" subtitle="Fixed-price treatment bundles" />
                  <Table>
                    <THead><TR>
                      <TH>Bundle</TH><TH>Treatment</TH><TH>Price</TH><TH>Sessions</TH><TH>Start</TH><TH>Status</TH>
                      {canLogMachineVisit && <TH> </TH>}
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
                          {canLogMachineVisit && (
                            <TD>
                              {p.status === "active" && p.totalSessions - p.usedSessions > 0 && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setMachineVisitPreselect(`pkg:${p.id}`);
                                    setMachineVisitOpen(true);
                                  }}
                                >
                                  Log visit
                                </Button>
                              )}
                            </TD>
                          )}
                        </TR>
                      ))}
                      {client.packages.length === 0 && (
                        <TR><TD colSpan={canLogMachineVisit ? 7 : 6} className="py-6 text-center text-slate-400">No bundles.</TD></TR>
                      )}
                    </TBody>
                  </Table>
                </Card>

                <Card>
                  <CardHeader title="Sessions" subtitle="Purchased per session" />
                  {sessionPlans.length === 0 ? (
                    <CardBody className="text-sm text-slate-400">No sessions.</CardBody>
                  ) : (
                    <Table>
                      <THead><TR>
                        <TH>Treatment</TH><TH>Unit price</TH><TH>Prescribed</TH><TH>Purchased</TH><TH>Used</TH><TH>Available</TH><TH>Status</TH>
                        {canLogMachineVisit && <TH> </TH>}
                      </TR></THead>
                      <TBody>
                        {sessionPlans.map((p) => (
                          <TR key={p.id}>
                            <TD className="font-medium">{p.machine ?? NO_MACHINE_LABEL}</TD>
                            <TD>{formatMoney(p.unitPrice, p.currency)}</TD>
                            <TD>{p.sessionsNeeded}</TD>
                            <TD>{p.sessionsPaid}</TD>
                            <TD>{p.sessionsUsed}</TD>
                            <TD>
                              <span className={p.sessionsAvailable > 0 ? "font-medium text-emerald-600" : "text-slate-500"}>
                                {p.sessionsAvailable}
                              </span>
                            </TD>
                            <TD><Badge tone={p.status === "active" ? "green" : p.status === "completed" ? "gray" : "red"}>{p.status}</Badge></TD>
                            {canLogMachineVisit && (
                              <TD>
                                {p.status === "active" && p.sessionsAvailable > 0 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setMachineVisitPreselect(`plan:${p.id}`);
                                      setMachineVisitOpen(true);
                                    }}
                                  >
                                    Log visit
                                  </Button>
                                )}
                              </TD>
                            )}
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
                  <THead><TR><TH>Date</TH><TH>Time</TH><TH>Visit</TH><TH>Doctor</TH><TH>Status</TH>{canManageAppointments && <TH>Actions</TH>}</TR></THead>
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
                              <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => setRescheduleTarget(a)}>
                                  <CalendarClock className="h-3.5 w-3.5" /> Reschedule
                                </Button>
                                <Button size="sm" variant="danger" onClick={() => setCancelTarget(a)}>
                                  <CalendarX className="h-3.5 w-3.5" /> Cancel
                                </Button>
                              </div>
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

            {active === "Visits" && isDietitian && (
              <div className="space-y-3">
                {visitTimeline.length === 0 && <p className="text-sm text-slate-400">No visits yet.</p>}
                {visitTimeline.map((entry) => {
                  if (entry.kind === "machine") {
                    return (
                      <MachineVisitCard
                        key={entry.visit.id}
                        visit={entry.visit}
                        canVoid={canLogMachineVisit}
                        onVoid={(v) => {
                          setVoidReason("");
                          setVoidTarget(v);
                        }}
                      />
                    );
                  }
                  const c = entry.consultation;
                  // Only a closed visit is a finalized record worth opening as a
                  // read-only summary; an in-progress draft keeps "Continue" as
                  // its one action and stays inert as a card.
                  const isClosed = c.status === "closed";
                  return (
                  <Card
                    key={c.id}
                    onClick={isClosed ? () => setSummaryVisitId(c.id) : undefined}
                  >
                    <CardBody>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="flex items-center gap-2 font-medium text-slate-800">
                            Visit #{c.visitNumber} · {formatDate(c.date)}
                            {isClosed ? (
                              <Badge tone="gray">Closed</Badge>
                            ) : (
                              <Badge tone="amber">In progress</Badge>
                            )}
                          </p>
                          <p className="text-xs text-slate-500">{c.dietitianName}</p>
                        </div>
                        <div className="flex items-center gap-3 text-right text-sm">
                          <div>
                            {c.weightKg && <span className="font-medium text-slate-700">{c.weightKg} kg</span>}
                            {c.bmi && <span className="ml-2 text-slate-400">BMI {c.bmi}</span>}
                          </div>
                          {isClosed ? (
                            <span className="text-xs text-slate-400">View summary</span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/consultations/new?client=${client.id}&consultation=${c.id}${apptParam}`)}
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
                        (c.botoxItems && c.botoxItems.length > 0) ||
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
                              <span className="font-medium text-slate-700">{t.machine}: </span>
                              {t.bodyParts.length > 0 ? t.bodyParts.join(", ") : "—"}
                              {t.price !== undefined && t.price > 0 && (
                                <span className="text-slate-400"> · {formatMoney(t.price, t.currency)}</span>
                              )}
                              <span className="text-slate-400"> · {t.sessionsUsed} session{t.sessionsUsed !== 1 ? "s" : ""} used{t.packageName ? ` (${t.packageName})` : t.sessionPlanId ? " (session plan)" : ""}</span>
                            </p>
                          ))}
                          {c.botoxItems?.map((b) => (
                            <p key={b.id}>
                              <span className="font-medium text-slate-700">Botox: </span>
                              {b.name} ×{b.quantity} · {formatMoney(b.chargedPrice * b.quantity, b.currency)}
                              {b.notes && <span className="text-slate-400"> · {b.notes}</span>}
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
                  );
                })}
              </div>
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
                {(pendingBaskets.data ?? []).length > 0 && (
                  <Card>
                    <CardHeader title="To settle" />
                    <CardBody className="space-y-2">
                      {(pendingBaskets.data ?? []).map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-800">
                              {formatMoney(b.total, "USD")}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {b.items.filter((i) => !i.covered).map((i) => i.label).join(", ")}
                            </p>
                          </div>
                          <Button size="sm" onClick={() => setOpenBasketId(b.id)}>
                            Open &amp; settle
                          </Button>
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                )}
                <Card>
                  <Table>
                    <THead><TR><TH>Receipt</TH><TH>Motif</TH><TH>Amount</TH><TH>Method</TH><TH>Date</TH><TH></TH></TR></THead>
                    <TBody>
                      {pays.map((p) => (
                        <TR key={p.id}>
                          <TD className="font-mono text-xs">{p.receiptNumber}</TD>
                          <TD>{p.motif}</TD>
                          <TD className="font-medium">
                            {formatTender(p.amountPaid, p.currency)}
                            {p.cardSurchargeAmount > 0 && (
                              <span className="ml-1 text-xs font-normal text-slate-400">
                                (incl. {formatTender(p.cardSurchargeAmount, p.currency)} card fee)
                              </span>
                            )}
                            {p.currency !== "USD" && (
                              <span className="block text-xs font-normal text-slate-400">
                                ≈ {formatUsd(p.amountUsd)}
                                {p.fxRate !== undefined && ` · ${formatFxRate(p.currency, p.fxRate)}`}
                              </span>
                            )}
                          </TD>
                          <TD className="capitalize text-slate-500">{p.method.replace("_", " ")}</TD>
                          <TD className="text-slate-500">{formatDate(p.date)}</TD>
                          <TD className="text-right">
                            <a
                              href={api.receiptPrintUrl(p.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm font-medium text-brand-700 hover:underline"
                            >
                              Print
                            </a>
                          </TD>
                        </TR>
                      ))}
                      {pays.length === 0 && <TR><TD colSpan={6} className="py-6 text-center text-slate-400">No payments.</TD></TR>}
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
                            <TD className="font-medium">
                              {formatMoney(d.amount, d.currency)}
                              {/* A part-paid debt shows what is still owed — the
                                  principal alone would overstate it. */}
                              {d.status === "outstanding" && d.paidAmount > 0 && (
                                <span className="block text-xs font-normal text-slate-400">
                                  {formatUsd(d.outstandingAmount)} still owed
                                </span>
                              )}
                            </TD>
                            <TD>
                              <Badge tone={d.status === "outstanding" ? (d.paidAmount > 0 ? "blue" : "amber") : d.status === "cleared" ? "green" : "gray"}>
                                {d.status === "outstanding"
                                  ? d.paidAmount > 0
                                    ? "Part-paid"
                                    : "Outstanding"
                                  : d.status === "cleared"
                                    ? "Collected"
                                    : "Written off"}
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
                                      setDebtCurrency("USD");
                                      setDebtTenderAmount("");
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

            {active === "Notes" && isDietitian && (
              <Card>
                {canEditClinical && (
                  <CardHeader
                    title="Clinical notes"
                    subtitle="Medical notes and allergies — doctor and admin only"
                    action={
                      <Button size="sm" variant="outline" onClick={() => setEditNotesOpen(true)}>
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                    }
                  />
                )}
                <CardBody className="space-y-4">
                  <div>
                    <p className="text-xs uppercase text-slate-400">Medical notes</p>
                    <p className="mt-1 text-sm text-slate-600">{client.medicalNotes ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-slate-400">Allergies / restrictions</p>
                    <p className="mt-1 text-sm text-slate-600">{client.allergies ?? "—"}</p>
                  </div>
                </CardBody>
              </Card>
            )}

            {active === "Files" && (
              <FilesTab
                clientId={client.id}
                clientPhone={client.phone}
                clientFirstName={client.firstName}
              />
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
                  Collect <span className="font-semibold text-slate-800">{formatUsd(debtAction.debt.outstandingAmount)}</span>{" "}
                  for “{debtAction.debt.reason}”.
                  {debtAction.debt.paidAmount > 0 && (
                    <>
                      {" "}
                      <span className="text-slate-500">
                        ({formatUsd(debtAction.debt.paidAmount)} of {formatUsd(debtAction.debt.amount)} already collected.)
                      </span>
                    </>
                  )}{" "}
                  The debt is owed in USD — it can be paid in any currency below.
                </>
              ) : (
                <>
                  Write off <span className="font-semibold text-slate-800">{formatUsd(debtAction.debt.outstandingAmount)}</span>{" "}
                  for “{debtAction.debt.reason}”. No payment is recorded — the debt is forgiven and closed.
                </>
              )}
            </p>
            {debtAction.mode === "clear" && (() => {
              const outstanding = debtAction.debt.outstandingAmount;
              const rates = {
                usdToLbp: settings.data?.usdToLbp ?? CLINIC.defaultUsdToLbp,
                usdToEur: settings.data?.usdToEur ?? CLINIC.defaultUsdToEur,
              };
              let fxRate: number | null;
              try {
                fxRate = fxRateFor(debtCurrency, rates);
              } catch {
                fxRate = null;
              }
              // Blank amount = collect the whole balance, expressed in the chosen
              // currency, so the desk is told exactly what to take.
              const typed = parseNumberInput(debtTenderAmount);
              const native =
                typed > 0
                  ? typed
                  : fxRate === null
                    ? 0
                    : usdToTender(outstanding, debtCurrency, fxRate);
              const appliedUsd = fxRate === null ? 0 : tenderToUsd(native, debtCurrency, fxRate);
              const remainingUsd = Math.max(0, Math.round((outstanding - appliedUsd) * 100) / 100);
              const overpaying = appliedUsd - outstanding > 0.01;
              const surchargePct = settings.data?.cardSurchargePercent ?? 0;
              const fee = cardSurchargeAmount(native, debtMethod, surchargePct);
              return (
                <>
                  <div className="flex gap-2">
                    <FormRow label="Payment method" className="flex-1">
                      <Select
                        value={debtMethod}
                        onChange={(e) => {
                          const method = e.target.value as PaymentMethod;
                          setDebtMethod(method);
                          // Jessy's ledger is USD-only; the server refuses anything else.
                          if (method === JESSY_METHOD) setDebtCurrency("USD");
                        }}
                      >
                        {PAYMENT_METHOD_VALUES.map((m) => (
                          <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                        ))}
                      </Select>
                    </FormRow>
                    <FormRow label="Currency" className="w-32">
                      <Select
                        value={debtCurrency}
                        disabled={debtMethod === JESSY_METHOD}
                        onChange={(e) => setDebtCurrency(e.target.value as TenderCurrency)}
                      >
                        {(debtMethod === JESSY_METHOD
                          ? (["USD"] as const)
                          : TENDER_CURRENCY_VALUES
                        ).map((c) => (
                          <option key={c} value={c}>{TENDER_CURRENCY_LABELS[c]}</option>
                        ))}
                      </Select>
                    </FormRow>
                  </div>
                  <FormRow label={`Amount collected (${debtCurrency})`}>
                    <MoneyInput
                      value={debtTenderAmount}
                      onValueChange={setDebtTenderAmount}
                      placeholder={fxRate === null ? "0" : String(native)}
                    />
                    <p className="mt-1 text-xs text-slate-400">
                      Leave blank to collect the whole balance. A smaller amount is recorded as a
                      part-payment and the debt stays open.
                    </p>
                  </FormRow>
                  {fxRate === null ? (
                    <p className="text-xs font-medium text-rose-600">
                      No usable {debtCurrency} rate — set one in Pricing before collecting.
                    </p>
                  ) : (
                    <div className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Collecting</span>
                        <span className="font-medium text-slate-700">
                          {formatTender(native, debtCurrency)}
                          {debtCurrency !== "USD" && (
                            <span className="text-slate-400"> · {formatFxRate(debtCurrency, fxRate)}</span>
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">USD equivalent</span>
                        <span className="font-medium text-slate-700">{formatUsd(appliedUsd)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Debt remaining after</span>
                        <span className={`font-semibold ${remainingUsd > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                          {formatUsd(remainingUsd)}
                        </span>
                      </div>
                    </div>
                  )}
                  {overpaying && (
                    <p className="text-xs font-medium text-rose-600">
                      That is more than the {formatUsd(outstanding)} outstanding — the clinic records no
                      credit balances, so reduce the amount.
                    </p>
                  )}
                  {fee > 0 && (
                    <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      <span className="font-medium">Card fee {surchargePct}%</span>
                      <span>+{formatTender(fee, debtCurrency)}</span>
                      <span className="text-amber-400">→</span>
                      <span className="font-semibold">
                        {formatTender(native + fee, debtCurrency)} charged
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
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

      <ScheduleAppointmentModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        clientId={client.id}
        clientName={`${client.firstName} ${client.lastName}`}
        defaultDietitianId={(staff.data ?? []).find((s) => s.fullName === client.assignedDietitian)?.id ?? null}
        onScheduled={refetch}
      />

      <RescheduleAppointmentModal
        appointment={rescheduleTarget}
        onClose={() => setRescheduleTarget(null)}
        onRescheduled={refetch}
      />

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

      {canLogMachineVisit && (
        <LogMachineVisitModal
          open={machineVisitOpen}
          clientId={client.id}
          clientName={`${client.firstName} ${client.lastName}`}
          preselectKey={machineVisitPreselect}
          onClose={() => setMachineVisitOpen(false)}
          onLogged={() => {
            machineVisits.refetch();
            refetch();
          }}
        />
      )}

      {canHandleMoney && (
        <SellSessionsModal
          open={sellSessionsOpen}
          clientId={client.id}
          clientName={`${client.firstName} ${client.lastName}`}
          onClose={() => setSellSessionsOpen(false)}
          onSold={() => {
            pendingBaskets.refetch();
            refetch();
          }}
        />
      )}

      {canHandleMoney &&
        (() => {
          const basket = (pendingBaskets.data ?? []).find((b) => b.id === openBasketId);
          if (!basket) return null;
          return (
            <VisitBasketSettlementModal
              key={basket.id}
              basket={basket}
              products={productCatalog.data ?? []}
              outstandingDebts={debts.filter((d) => d.status === "outstanding")}
              canSettle={canHandleMoney}
              onClose={() => setOpenBasketId(null)}
              onChanged={() => {
                setOpenBasketId(null);
                pendingBaskets.refetch();
                refetch();
              }}
            />
          );
        })()}

      <Modal
        open={!!voidTarget}
        onClose={() => setVoidTarget(null)}
        title="Void machine visit"
        footer={
          <>
            <Button variant="outline" onClick={() => setVoidTarget(null)} disabled={voidSaving}>
              Cancel
            </Button>
            <Button variant="danger" onClick={voidMachineVisit} disabled={voidSaving}>
              {voidSaving ? "Voiding…" : "Void"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {voidTarget?.items.map((i) => `${i.machine ?? NO_MACHINE_LABEL} ×${i.sessions}`).join(", ")}
          </p>
          <div>
            <Label htmlFor="void-reason">Reason (optional)</Label>
            <Input
              id="void-reason"
              value={voidReason}
              maxLength={300}
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {isDietitian && (
        <VisitSummaryModal
          consultation={
            consults.find((c) => c.id === summaryVisitId && c.status === "closed") ?? null
          }
          onClose={() => setSummaryVisitId(null)}
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
