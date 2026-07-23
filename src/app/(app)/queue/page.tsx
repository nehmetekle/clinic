"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  Clock,
  MoreVertical,
  RotateCcw,
  Stethoscope,
  UserCheck,
  UserX,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { AppointmentBadge, Badge } from "@/components/ui/Badge";
import { Loading, ErrorState } from "@/components/ui/States";
import { VisitBasketSettlementModal } from "@/components/VisitBasketSettlementModal";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { clinicDay, todayIso } from "@/lib/config";
import type {
  Appointment,
  AppointmentStatus,
  ConsultationListItem,
  VisitBasket,
} from "@/lib/types";
import { cn, formatDate, formatMoney, formatTime } from "@/lib/utils";

// Secretary-driven queue progression: scheduled → checked-in → with dietitian.
// Completion isn't a queue action — the appointment is marked completed when the
// dietitian saves and closes the consultation.
const NEXT_STATUS: Partial<Record<AppointmentStatus, AppointmentStatus>> = {
  scheduled: "checked_in",
  checked_in: "with_dietitian",
};

const NEXT_LABEL: Partial<Record<AppointmentStatus, string>> = {
  scheduled: "Check in",
  checked_in: "Send to doctor",
};

// A client who is checked in or in with the dietitian is physically present now,
// so they stay on the board regardless of their appointment's scheduled date —
// until the dietitian closes the visit (which flips the appointment to completed
// and retires its paid basket). This keeps the invariant that a basket on the
// board always has its client on the board.
const LIVE_ON_BOARD: AppointmentStatus[] = ["checked_in", "with_dietitian"];

// A visit closed today belongs in today's "Done", even if its appointment was
// scheduled for another day — key that on the completion time (in clinic time),
// not the stored date.
function completedToday(a: Appointment): boolean {
  return (
    a.status === "completed" && !!a.completedAt && clinicDay(new Date(a.completedAt)) === todayIso()
  );
}

// The three flow lanes of the board, in the order a patient moves through them.
// Each lane carries its own icon and status-tone styling so the stage is legible
// at a glance and the card accents echo the AppointmentBadge palette.
const STAGES: {
  key: string;
  title: string;
  statuses: AppointmentStatus[];
  icon: LucideIcon;
  emptyText: string;
}[] = [
  { key: "scheduled", title: "Scheduled", statuses: ["scheduled"], icon: CalendarClock, emptyText: "No one scheduled" },
  { key: "checked_in", title: "In clinic", statuses: ["checked_in"], icon: UserCheck, emptyText: "No one waiting" },
  {
    key: "with_dietitian",
    title: "With doctor",
    statuses: ["with_dietitian"],
    icon: Stethoscope,
    emptyText: "No active consults",
  },
];

const STAGE_STYLES: Record<
  string,
  { iconBox: string; chip: string; avatar: string; cardAccent: string }
> = {
  scheduled: {
    iconBox: "bg-slate-200 text-slate-600",
    chip: "bg-slate-200 text-slate-700",
    avatar: "bg-slate-100 text-slate-600",
    cardAccent: "border-l-slate-300",
  },
  checked_in: {
    iconBox: "bg-blue-100 text-blue-600",
    chip: "bg-blue-100 text-blue-700",
    avatar: "bg-blue-100 text-blue-700",
    cardAccent: "border-l-blue-400",
  },
  with_dietitian: {
    iconBox: "bg-purple-100 text-purple-600",
    chip: "bg-purple-100 text-purple-700",
    avatar: "bg-purple-100 text-purple-700",
    cardAccent: "border-l-purple-400",
  },
};

// No-show is reachable from two present-tense stages: a client who never arrived
// ("scheduled"), and a client who checked in but left before the dietitian saw
// them ("checked_in"). Both clear an honest dead-end off the board using the one
// terminal no-show status; the label differs per stage (see the card controls).
function canMarkNoShow(status: AppointmentStatus): boolean {
  return status === "scheduled" || status === "checked_in";
}

// Initials for a card avatar, derived from the displayed client name (first +
// last word). Purely presentational — no new data is introduced.
function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export default function QueuePage() {
  const router = useRouter();
  const { user } = useSession();
  const { toast } = useToast();
  // The day the board is showing. Defaults to today (the live board); the picker
  // lets staff look ahead/back at another day's roster. Only today is actionable —
  // other days render read-only (see isToday gating below).
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const isToday = selectedDate === todayIso();
  const { data, loading, error, refetch } = useApi(() => api.listAppointments());
  // Baskets the dietitian has sent for payment, plus the catalog for add-ons.
  const { data: basketData, refetch: refetchBaskets } = useApi(() => api.listVisitBaskets());
  const productCatalog = useApi(() => api.listProducts());
  // Outstanding debts, so a client's old balance can be auto-suggested in their
  // basket at settlement and collected alongside today's charges.
  const { data: debtData, refetch: refetchDebts } = useApi(() => api.listOutstandingDebts());
  // The selected day's open (in-progress) visits, so a "With dietitian" card can
  // link straight back to the one the dietitian already started. Fetched
  // date+status-filtered (not the whole table) and refetched when the date changes.
  const { data: consultationData } = useApi(
    () => api.listConsultations({ status: "open", date: selectedDate }),
    [selectedDate],
  );

  // Local board state seeded from the database; transitions persist via the API.
  const [items, setItems] = useState<Appointment[]>([]);
  const [openBasket, setOpenBasket] = useState<VisitBasket | null>(null);
  // Which in-clinic card has its "⋮" overflow menu open (by appointment id).
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (isToday) {
      // Today's live board: today's scheduled clients, plus anyone still live in the
      // flow regardless of the appointment's stored date (see LIVE_ON_BOARD) — so a
      // settled-but-not-yet-closed client stays visible while their basket is still
      // on the board — plus any visit closed today, so it lands in "Done" even if it
      // was scheduled for a different day.
      setItems(
        data.filter(
          (a) =>
            a.date === todayIso() || LIVE_ON_BOARD.includes(a.status) || completedToday(a),
        ),
      );
    } else {
      // Another day: just that day's roster by scheduled date. The cross-date "live"
      // and "closed today" carry-overs are today-only concepts, so they don't apply.
      setItems(data.filter((a) => a.date === selectedDate));
    }
  }, [data, selectedDate, isToday]);

  const isSecretary = user?.role === "secretary" || user?.role === "admin";
  const hideMedicalHistoryStatus = user?.role === "secretary" || user?.role === "admin";
  const hideIntakeStatus = user?.role === "secretary" || user?.role === "admin";

  // Settlement column: pending baskets first (actionable), then recently paid.
  // Only live baskets belong on the board: `pending` (awaiting settlement) and
  // `paid` (settled, but the dietitian hasn't closed the visit yet — the client is
  // still in "With dietitian"). The terminal state is excluded: a `paid` basket
  // becomes `closed` once the dietitian closes the visit (client → Done).
  // Settlement is a live activity, so the Payment lane only carries baskets on
  // today's board; another day's view has nothing to settle.
  const paymentBaskets = (isToday ? (basketData ?? []) : [])
    .filter((b) => b.status === "pending" || b.status === "paid")
    .sort((a, b) =>
      a.status !== b.status
        ? a.status === "pending"
          ? -1
          : 1
        : b.sentAt.localeCompare(a.sentAt),
    );
  const pendingCount = paymentBaskets.filter((b) => b.status === "pending").length;

  // Client → the visit they already started on the selected day, so a "With
  // dietitian" card offers "Continue" (reopen the saved visit) instead of a fresh
  // "Consult". The fetch is already scoped to open visits on this day, so a stale
  // never-closed draft from another day can't hijack it; the list is date-desc, so
  // the first match kept is the most recent.
  const openConsultByClient = new Map<string, ConsultationListItem>();
  for (const c of consultationData ?? []) {
    if (c.status === "open" && !openConsultByClient.has(c.clientId)) {
      openConsultByClient.set(c.clientId, c);
    }
  }

  // Check-in opens the full registration form so missing details are completed
  // before the patient moves into the clinic.
  function startCheckIn(appt: Appointment) {
    router.push(`/clients/${appt.clientId}/checkin?appt=${appt.id}`);
  }

  async function advance(appt: Appointment) {
    const nextStatus = NEXT_STATUS[appt.status];
    if (!nextStatus) return;
    // Optimistic move, persisted to the database; resync on failure.
    setItems((prev) => prev.map((a) => (a.id === appt.id ? { ...a, status: nextStatus } : a)));
    try {
      await api.setAppointmentStatus(appt.id, nextStatus);
      toast(`${appt.clientName} → ${nextStatus.replace("_", " ")}`);
    } catch (e) {
      toast((e as Error).message);
      refetch();
    }
  }

  async function markNoShow(appt: Appointment) {
    if (!canMarkNoShow(appt.status)) return;
    setItems((prev) => prev.map((a) => (a.id === appt.id ? { ...a, status: "no_show" } : a)));
    try {
      await api.setAppointmentStatus(appt.id, "no_show");
      toast(`${appt.clientName} → no-show`);
    } catch (e) {
      toast((e as Error).message);
      refetch();
    }
  }

  // A no-show who later shows up: send them back to Scheduled so they can be
  // checked in as normal.
  async function undoNoShow(appt: Appointment) {
    if (appt.status !== "no_show") return;
    setItems((prev) => prev.map((a) => (a.id === appt.id ? { ...a, status: "scheduled" } : a)));
    try {
      await api.setAppointmentStatus(appt.id, "scheduled");
      toast(`${appt.clientName} → back to scheduled`);
    } catch (e) {
      toast((e as Error).message);
      refetch();
    }
  }

  // Finished appointments are listed as rows below the board rather than a column.
  const doneStatuses: AppointmentStatus[] = ["completed", "no_show", "cancelled"];
  const doneItems = items
    .filter((a) => doneStatuses.includes(a.status))
    .sort((a, b) => a.time.localeCompare(b.time));

  const countOf = (status: AppointmentStatus) => items.filter((a) => a.status === status).length;

  // Day-at-a-glance pipeline: the same counts already shown on each column, lifted
  // to the top so staff read the shape of the day in one pass.
  const pipeline = [
    { label: "Scheduled", value: countOf("scheduled"), dot: "bg-slate-400" },
    { label: "In clinic", value: countOf("checked_in"), dot: "bg-blue-500" },
    { label: "With doctor", value: countOf("with_dietitian"), dot: "bg-purple-500" },
    { label: "To settle", value: pendingCount, dot: "bg-amber-500" },
    { label: "Done", value: doneItems.length, dot: "bg-emerald-500" },
  ];

  return (
    <div>
      <PageHeader
        title={isToday ? "Today's queue" : "Queue"}
        subtitle={`${formatDate(selectedDate)} · ${isToday ? "live check-in board" : "read-only view"}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value || todayIso())}
              className="w-40"
            />
            {!isToday && (
              <Button variant="outline" onClick={() => setSelectedDate(todayIso())}>
                Today
              </Button>
            )}
            {isSecretary && (
              <Button onClick={() => router.push("/appointments/phone-booking")}>
                <CalendarPlus className="h-4 w-4" /> Schedule appointment
              </Button>
            )}
          </div>
        }
      />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <>
          {/* Day-at-a-glance strip — the day's flow, left to right. */}
          <div className="mb-5 flex flex-wrap items-stretch gap-2">
            {pipeline.map((tile, i) => (
              <Fragment key={tile.label}>
                <div className="flex flex-1 basis-[132px] flex-col justify-center rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-card">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("h-1.5 w-1.5 rounded-full", tile.dot)} />
                    <span className="text-xs font-medium text-slate-500">{tile.label}</span>
                  </div>
                  <span className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                    {tile.value}
                  </span>
                </div>
                {i < pipeline.length - 1 && (
                  <ChevronRight className="hidden h-4 w-4 shrink-0 self-center text-slate-300 lg:block" />
                )}
              </Fragment>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {STAGES.map((stage) => {
              const st = STAGE_STYLES[stage.key];
              const Icon = stage.icon;
              const colItems = items.filter((a) => stage.statuses.includes(a.status));
              return (
                <section
                  key={stage.key}
                  className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", st.iconBox)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <h3 className="text-sm font-semibold text-slate-800">{stage.title}</h3>
                    </div>
                    <span
                      className={cn(
                        "inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold",
                        st.chip,
                      )}
                    >
                      {colItems.length}
                    </span>
                  </div>

                  <div className="flex flex-1 flex-col gap-3 p-3">
                    {colItems.length === 0 && (
                      <p className="py-8 text-center text-xs text-slate-400">{stage.emptyText}</p>
                    )}
                    {colItems.map((a) => {
                      const showMedicalHistoryWarning =
                        !hideMedicalHistoryStatus && a.hasMedicalHistory === false;
                      const showIntakeWarning = !hideIntakeStatus && a.intakeComplete === false;
                      const needsAttention = showMedicalHistoryWarning || showIntakeWarning;
                      // Only today's board is actionable; another day's view is
                      // read-only, so all the move/check-in/consult controls are
                      // gated on isToday and such a card shows just "Profile".
                      const isScheduledSecretary = isToday && isSecretary && a.status === "scheduled";
                      // A checked-in client who leaves before the dietitian sees
                      // them is a dead-end on the board: give the secretary a "⋮"
                      // overflow menu to clear it via the shared no-show status.
                      const showLeftMenu = isToday && isSecretary && a.status === "checked_in";
                      const showAdvance = isToday && isSecretary && !!NEXT_LABEL[a.status];
                      const showConsult =
                        isToday && a.status === "with_dietitian" && user?.role !== "secretary";
                      // A visit the dietitian already saved (open) — "Consult" becomes
                      // "Continue" and reopens it directly instead of routing to the profile.
                      const openConsult = showConsult
                        ? openConsultByClient.get(a.clientId)
                        : undefined;
                      const soloProfile = !showAdvance && !showConsult;
                      return (
                        <div
                          key={a.id}
                          className={cn(
                            "rounded-lg border border-l-[3px] border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow-card",
                            st.cardAccent,
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <span
                              className={cn(
                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                                st.avatar,
                              )}
                            >
                              {nameInitials(a.clientName)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-slate-800">
                                {a.clientName}
                              </p>
                              <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                                <Clock className="h-3 w-3 shrink-0" /> {formatTime(a.time)}
                              </p>
                            </div>
                            <AppointmentBadge status={a.status} />
                          </div>

                          {/* The dietitian she's here to see, and who referred her. */}
                          <div className="mt-3 space-y-1 border-t border-slate-100 pt-2.5 text-xs">
                            <p className="flex items-center gap-1.5 text-slate-600">
                              <Stethoscope className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                              <span className="truncate font-medium">{a.dietitianName}</span>
                            </p>
                            <p className="text-slate-500">
                              <span className="font-medium text-slate-400">Referrer:</span>{" "}
                              {a.referralSource ?? "—"}
                            </p>
                          </div>

                          {needsAttention && (
                            <div className="mt-2.5 space-y-1.5">
                              {showMedicalHistoryWarning && (
                                <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                  Medical history needs to be taken
                                </div>
                              )}
                              {showIntakeWarning && (
                                <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                  Needs intake
                                </div>
                              )}
                            </div>
                          )}

                          {isScheduledSecretary ? (
                            <div className="mt-3 space-y-2">
                              <Button size="sm" className="w-full" onClick={() => startCheckIn(a)}>
                                <CheckCircle2 className="h-3.5 w-3.5" /> Check in
                              </Button>
                              <div className="grid grid-cols-2 gap-2">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-rose-600 hover:bg-rose-50"
                                  onClick={() => markNoShow(a)}
                                >
                                  <UserX className="h-3.5 w-3.5" /> No-show
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => router.push(`/clients/${a.clientId}`)}
                                >
                                  Profile
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-3 flex gap-2">
                              {showAdvance && (
                                <Button size="sm" className="flex-1" onClick={() => advance(a)}>
                                  <ArrowRight className="h-3.5 w-3.5" /> {NEXT_LABEL[a.status]}
                                </Button>
                              )}
                              {showConsult && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="flex-1"
                                  onClick={() =>
                                    router.push(
                                      openConsult
                                        ? `/consultations/new?client=${a.clientId}&consultation=${openConsult.id}`
                                        : `/clients/${a.clientId}`,
                                    )
                                  }
                                >
                                  <Stethoscope className="h-3.5 w-3.5" />{" "}
                                  {openConsult ? "Continue" : "Consult"}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant={soloProfile ? "outline" : "ghost"}
                                className={cn(soloProfile && "flex-1")}
                                onClick={() => router.push(`/clients/${a.clientId}`)}
                              >
                                Profile
                              </Button>
                              {showLeftMenu && (
                                <div className="relative">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="More actions"
                                    onClick={() =>
                                      setMenuOpenId((prev) => (prev === a.id ? null : a.id))
                                    }
                                  >
                                    <MoreVertical className="h-3.5 w-3.5" />
                                  </Button>
                                  {menuOpenId === a.id && (
                                    <>
                                      {/* Click-away backdrop; below the menu, above the board. */}
                                      <div
                                        className="fixed inset-0 z-10"
                                        onClick={() => setMenuOpenId(null)}
                                      />
                                      <div className="absolute right-0 z-20 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                                        <button
                                          type="button"
                                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium text-rose-600 hover:bg-rose-50"
                                          onClick={() => {
                                            setMenuOpenId(null);
                                            markNoShow(a);
                                          }}
                                        >
                                          <UserX className="h-3.5 w-3.5 shrink-0" />
                                          Client left without being seen
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {/* Payment lane — the checkout desk. Baskets the dietitian sent for the
                secretary to settle; distinct teal identity, pending highlighted. */}
            <section className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                    <Wallet className="h-4 w-4" />
                  </span>
                  <h3 className="text-sm font-semibold text-slate-800">Payment</h3>
                </div>
                <span
                  className={cn(
                    "inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold",
                    pendingCount > 0 ? "bg-amber-100 text-amber-700" : "bg-slate-200 text-slate-600",
                  )}
                >
                  {pendingCount}
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-3 p-3">
                {paymentBaskets.length === 0 && (
                  <p className="py-8 text-center text-xs text-slate-400">No baskets sent yet.</p>
                )}
                {paymentBaskets.map((b) => {
                  const isPending = b.status === "pending";
                  return (
                    <div
                      key={b.id}
                      className={cn(
                        "rounded-lg border border-l-[3px] border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow-card",
                        isPending ? "border-l-amber-400" : "border-l-emerald-400",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-800">
                            {b.clientName}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-600">
                            <Stethoscope className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="truncate font-medium">{b.dietitianName}</span>
                          </p>
                        </div>
                        <Badge tone={isPending ? "amber" : "green"}>
                          {isPending ? "Pending" : "Paid"}
                        </Badge>
                      </div>
                      <div className="mt-2.5 flex items-baseline justify-between border-t border-slate-100 pt-2.5">
                        <span className="text-base font-semibold text-slate-900">
                          {formatMoney(b.total, b.currency)}
                        </span>
                        <span className="text-xs text-slate-400">
                          {b.items.length} item{b.items.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant={isPending && isSecretary ? "primary" : "outline"}
                          className="w-full"
                          onClick={() => setOpenBasket(b)}
                        >
                          <Wallet className="h-3.5 w-3.5" />
                          {b.status === "paid"
                            ? "View basket"
                            : isSecretary
                              ? "Open & settle"
                              : "View basket"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </>
      )}

      {openBasket && (
        <VisitBasketSettlementModal
          key={openBasket.id}
          basket={openBasket}
          products={productCatalog.data ?? []}
          outstandingDebts={(debtData ?? []).filter((d) => d.clientId === openBasket.clientId)}
          canSettle={isSecretary}
          onClose={() => setOpenBasket(null)}
          onChanged={() => {
            refetchBaskets();
            refetchDebts();
          }}
        />
      )}

      {!loading && !error && (
        <Card className="mt-6">
          <CardHeader
            title="Done"
            subtitle={`${doneItems.length} client${doneItems.length !== 1 ? "s" : ""}`}
            action={<CheckCircle2 className="h-4 w-4 text-slate-300" />}
          />
          <CardBody className="p-0">
            {doneItems.length === 0 ? (
              <p className="px-5 py-8 text-center text-xs text-slate-400">No completed visits yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {doneItems.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <AppointmentBadge status={a.status} />
                      <span className="text-sm font-medium text-slate-800">{a.clientName}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTime(a.time)}
                      </span>
                      <span className="hidden sm:inline">{a.dietitianName}</span>
                      {a.referralSource && (
                        <span className="hidden sm:inline">Referrer: {a.referralSource}</span>
                      )}
                      {isToday && isSecretary && a.status === "no_show" && (
                        <Button size="sm" variant="ghost" onClick={() => undoNoShow(a)}>
                          <RotateCcw className="h-3.5 w-3.5" /> Undo
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => router.push(`/clients/${a.clientId}`)}
                      >
                        Profile
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <p className="mt-4 text-xs text-slate-400">
        {isToday
          ? "Check-in opens the patient registration form; required details must be completed before proceeding. Queue transitions are saved to the database."
          : "You're viewing another day — the board is read-only. Switch back to Today to check patients in and move them through the queue."}
      </p>
    </div>
  );
}
