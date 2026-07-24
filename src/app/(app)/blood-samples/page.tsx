"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FlaskConical,
  Plus,
  Send,
  StickyNote,
  TestTubes,
  Undo2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { BloodSampleFiles } from "@/components/BloodSampleFiles";
import { Loading, ErrorState } from "@/components/ui/States";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { addDaysIso, cn, formatDate } from "@/lib/utils";
import { CLINIC, clinicDay, clinicTimeInput, withClinicTime } from "@/lib/config";
import type { BloodSample } from "@/lib/types";
import type { UpdateBloodSampleInput } from "@/lib/validation";

// ---- small date/time helpers ----
// All day handling is anchored to the CLINIC's timezone (clinicDay), not the
// viewer's device — so the date arrows step exactly one clinic calendar day and
// "today" matches the clinic clock regardless of where the secretary logs in.
const dayOf = (iso?: string) => (iso ? clinicDay(new Date(iso)) : "");

function clock(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: CLINIC.timeZone,
  });
}

// Time-of-day display/edit is in clinic time too (clinicTimeInput / withClinicTime),
// so a sample's send/receive time reads and saves on the clinic clock for every
// user, wherever they are.
const toTimeInput = (iso: string) => clinicTimeInput(iso);
const withTime = (iso: string, hhmm: string) => withClinicTime(iso, hhmm);

const shiftDay = (iso: string, delta: number) => addDaysIso(iso, delta);

// ---- editable time chip ----
function TimeChip({
  iso,
  label,
  tone,
  editable,
  onSave,
}: {
  iso: string;
  label: string;
  tone: "blue" | "green";
  editable: boolean;
  onSave: (hhmm: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(toTimeInput(iso));
  useEffect(() => setVal(toTimeInput(iso)), [iso]);

  const toneClass =
    tone === "blue" ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700";

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="time"
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
          className="h-7 rounded-md border border-slate-300 px-1.5 text-xs focus:border-brand-500 focus:outline-none"
        />
        <button
          onClick={() => {
            setEditing(false);
            if (val) onSave(val);
          }}
          className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"
          aria-label="Save time"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setVal(toTimeInput(iso));
          }}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={!editable}
      onClick={() => editable && setEditing(true)}
      title={editable ? "Click to adjust the time" : undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        toneClass,
        editable && "hover:ring-1 hover:ring-slate-300",
      )}
    >
      <Clock className="h-3 w-3" />
      {label} {clock(iso)}
    </button>
  );
}

// ---- inline note ----
function NoteEditor({
  note,
  editable,
  onSave,
}: {
  note?: string;
  editable: boolean;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(note ?? "");
  useEffect(() => setVal(note ?? ""), [note]);

  if (editing) {
    return (
      <div className="mt-2 flex items-center gap-1">
        <input
          value={val}
          autoFocus
          maxLength={200}
          placeholder="Courier / lab reference…"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setEditing(false);
              onSave(val.trim());
            }
            if (e.key === "Escape") {
              setEditing(false);
              setVal(note ?? "");
            }
          }}
          className="h-7 flex-1 rounded-md border border-slate-300 px-2 text-xs focus:border-brand-500 focus:outline-none"
        />
        <button
          onClick={() => {
            setEditing(false);
            onSave(val.trim());
          }}
          className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"
          aria-label="Save note"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (!note) {
    if (!editable) return null;
    return (
      <button
        onClick={() => setEditing(true)}
        className="mt-2 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
      >
        <Plus className="h-3 w-3" /> Add note
      </button>
    );
  }

  return (
    <button
      onClick={() => editable && setEditing(true)}
      disabled={!editable}
      className="mt-2 flex items-start gap-1.5 text-left text-xs text-slate-500 hover:text-slate-700"
      title={editable ? "Click to edit note" : undefined}
    >
      <StickyNote className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
      <span>{note}</span>
    </button>
  );
}

// ---- one sample card ----
function SampleCard({
  sample,
  today,
  canManage,
  onSend,
  onReceive,
  onUnsend,
  onUnreceive,
  onEditTime,
  onSaveNote,
}: {
  sample: BloodSample;
  today: string;
  canManage: boolean;
  onSend: (s: BloodSample) => void;
  onReceive: (s: BloodSample) => void;
  onUnsend: (s: BloodSample) => void;
  onUnreceive: (s: BloodSample) => void;
  onEditTime: (s: BloodSample, field: "sent" | "received", hhmm: string) => void;
  onSaveNote: (s: BloodSample, note: string) => void;
}) {
  // Logging results is the one near-final step, so it's behind a confirm. Reset
  // the prompt whenever the sample moves on (e.g. it got reopened elsewhere).
  const [confirmReceive, setConfirmReceive] = useState(false);
  useEffect(() => setConfirmReceive(false), [sample.status]);

  const accent =
    sample.status === "pending"
      ? "border-l-amber-400"
      : sample.status === "sent"
        ? "border-l-blue-400"
        : "border-l-emerald-400";

  // Flag samples ordered before today so leftovers never get lost in the column.
  const straggler = sample.status !== "received" && dayOf(sample.orderedAt) !== today;

  return (
    <div className={cn("rounded-lg border border-l-4 border-slate-200 bg-white p-3", accent)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-800">{sample.clientName}</p>
          <p className="text-xs text-slate-400">Ordered by {sample.dietitianName}</p>
        </div>
        {straggler && <Badge tone="amber">from {formatDate(sample.orderedAt)}</Badge>}
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {sample.tests.length > 0 ? (
          sample.tests.map((t) => (
            <Badge key={t} tone="gray">
              {t}
            </Badge>
          ))
        ) : (
          <span className="text-xs italic text-slate-400">No specific tests listed</span>
        )}
      </div>

      {(sample.sentAt || sample.receivedAt) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {sample.sentAt && (
            <TimeChip
              iso={sample.sentAt}
              label="Sent"
              tone="blue"
              editable={canManage}
              onSave={(hhmm) => onEditTime(sample, "sent", hhmm)}
            />
          )}
          {sample.receivedAt && (
            <TimeChip
              iso={sample.receivedAt}
              label="Results"
              tone="green"
              editable={canManage}
              onSave={(hhmm) => onEditTime(sample, "received", hhmm)}
            />
          )}
        </div>
      )}

      <NoteEditor
        note={sample.notes}
        editable={canManage}
        onSave={(note) => onSaveNote(sample, note)}
      />

      {canManage && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Pending → sent. One click; fully reversible from the next step. */}
          {sample.status === "pending" && (
            <Button size="sm" className="flex-1" onClick={() => onSend(sample)}>
              <Send className="h-3.5 w-3.5" /> Mark sent
            </Button>
          )}

          {/* Sent → results, with an explicit "Undo send" back to Awaiting send. */}
          {sample.status === "sent" && !confirmReceive && (
            <>
              <Button size="sm" className="flex-1" onClick={() => setConfirmReceive(true)}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Results received
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onUnsend(sample)}>
                <Undo2 className="h-3.5 w-3.5" /> Undo send
              </Button>
            </>
          )}

          {/* Confirm step before logging results — guards the near-final action. */}
          {sample.status === "sent" && confirmReceive && (
            <div className="w-full rounded-lg bg-emerald-50 p-2.5">
              <p className="text-xs font-medium text-emerald-900">
                Log results as received for {sample.clientName}?
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setConfirmReceive(false);
                    onReceive(sample);
                  }}
                >
                  <Check className="h-3.5 w-3.5" /> Yes, results are in
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReceive(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Received → back to At lab. Always available, so a mistaken "results
              in" is never a dead end (secretary or admin can recover it). */}
          {sample.status === "received" && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => onUnreceive(sample)}
            >
              <Undo2 className="h-3.5 w-3.5" /> Undo — results not in yet
            </Button>
          )}
        </div>
      )}

      <BloodSampleFiles sampleId={sample.id} status={sample.status} className="mt-3" />
    </div>
  );
}

// ---- column shell ----
function Column({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
  empty,
}: {
  title: string;
  subtitle: string;
  icon: typeof Send;
  action?: React.ReactNode;
  children: React.ReactNode;
  empty: string;
}) {
  return (
    <Card className="bg-slate-50/50">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-slate-400" /> {title}
          </span>
        }
        subtitle={subtitle}
        action={action}
      />
      <CardBody className="space-y-3">
        {children ?? <p className="py-4 text-center text-xs text-slate-400">{empty}</p>}
      </CardBody>
    </Card>
  );
}

export default function BloodSamplesPage() {
  const router = useRouter();
  const { user } = useSession();
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi(() => api.listBloodSamples());

  // "Today" follows the real clock — the same clock the server stamps send /
  // receive times with — so logged results always land on the day the board is
  // showing and can never become unreachable. Day comparisons use the CLINIC's
  // calendar day (clinicDay), matching how the columns bucket each sample.
  const todayIso = useMemo(() => clinicDay(), []);

  const [items, setItems] = useState<BloodSample[]>([]);
  const [focusDate, setFocusDate] = useState(todayIso);
  useEffect(() => {
    if (data) setItems(data);
  }, [data]);

  const canManage = user?.role === "secretary" || user?.role === "admin";

  // Optimistic update: apply locally, persist, resync on failure.
  async function mutate(
    id: string,
    body: UpdateBloodSampleInput,
    optimistic: (s: BloodSample) => BloodSample,
    msg?: string,
  ) {
    setItems((prev) => prev.map((s) => (s.id === id ? optimistic(s) : s)));
    try {
      const updated = await api.updateBloodSample(id, body);
      setItems((prev) => prev.map((s) => (s.id === id ? updated : s)));
      if (msg) toast(msg);
    } catch (e) {
      toast((e as Error).message);
      refetch();
    }
  }

  const onSend = (s: BloodSample) =>
    mutate(
      s.id,
      { action: "send" },
      (x) => ({ ...x, sentAt: new Date().toISOString(), status: "sent" }),
      `${s.clientName} — sample sent`,
    );

  const onReceive = (s: BloodSample) =>
    mutate(
      s.id,
      { action: "receive" },
      (x) => ({ ...x, receivedAt: new Date().toISOString(), status: "received" }),
      `${s.clientName} — results received`,
    );

  const onUnsend = (s: BloodSample) =>
    mutate(s.id, { action: "unsend" }, (x) => ({
      ...x,
      sentAt: undefined,
      receivedAt: undefined,
      status: "pending",
    }));

  const onUnreceive = (s: BloodSample) =>
    mutate(s.id, { action: "unreceive" }, (x) => ({
      ...x,
      receivedAt: undefined,
      status: "sent",
    }));

  const onEditTime = (s: BloodSample, field: "sent" | "received", hhmm: string) => {
    const base = field === "sent" ? s.sentAt : s.receivedAt;
    if (!base) return;
    const at = withTime(base, hhmm);
    mutate(
      s.id,
      { action: field === "sent" ? "send" : "receive", at },
      (x) => ({ ...x, [field === "sent" ? "sentAt" : "receivedAt"]: at }),
      "Time updated",
    );
  };

  const onSaveNote = (s: BloodSample, note: string) =>
    mutate(s.id, { notes: note }, (x) => ({ ...x, notes: note || undefined }), "Note saved");

  // Columns. "Awaiting send" and "At lab" stay live (every outstanding sample,
  // any day) so nothing slips through; "Results in" is scoped to the focus day.
  const pending = items
    .filter((s) => s.status === "pending")
    .sort((a, b) => a.orderedAt.localeCompare(b.orderedAt));
  const sent = items
    .filter((s) => s.status === "sent")
    .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
  const received = items
    .filter((s) => s.status === "received" && dayOf(s.receivedAt) === focusDate)
    .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));

  const isToday = focusDate === todayIso;

  // Hidden native date input the calendar button opens, so a user can jump
  // straight to any past day's results instead of only stepping one day at a
  // time with the arrows. Guarded to not run past today (results can't be future).
  const dateInputRef = useRef<HTMLInputElement>(null);

  const cardProps = {
    today: todayIso,
    canManage,
    onSend,
    onReceive,
    onUnsend,
    onUnreceive,
    onEditTime,
    onSaveNote,
  };

  const dateNav = (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setFocusDate((d) => shiftDay(d, -1))}
        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        aria-label="Previous day"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-[64px] text-center text-xs font-medium text-slate-600">
        {isToday ? "Today" : formatDate(focusDate)}
      </span>
      <button
        onClick={() => setFocusDate((d) => shiftDay(d, 1))}
        disabled={focusDate >= todayIso}
        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="Next day"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <div className="relative">
        <button
          onClick={() => dateInputRef.current?.showPicker?.()}
          className={cn(
            "rounded-md p-1 hover:bg-slate-100 hover:text-slate-600",
            isToday ? "text-slate-400" : "text-brand-600",
          )}
          aria-label="Jump to a date"
          title="Jump to a specific date"
        >
          <CalendarDays className="h-4 w-4" />
        </button>
        {/* Sits under the icon; the button opens its native calendar. Clamped to
            today so a future day (which can't have results yet) is unpickable. */}
        <input
          ref={dateInputRef}
          type="date"
          value={focusDate}
          max={todayIso}
          onChange={(e) => e.target.value && setFocusDate(e.target.value)}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Blood samples"
        subtitle={`${formatDate(todayIso)} · track samples out to the lab and results back in`}
      />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Awaiting send"
              value={pending.length}
              icon={Send}
              tone="amber"
              hint="Ready for the courier"
            />
            <StatCard
              label="At lab"
              value={sent.length}
              icon={FlaskConical}
              tone="blue"
              hint="Awaiting results"
            />
            <StatCard
              label={isToday ? "Results in today" : "Results in"}
              value={received.length}
              icon={CheckCircle2}
              tone="green"
              hint={isToday ? undefined : formatDate(focusDate)}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Column
              title="Awaiting send"
              subtitle={`${pending.length} to hand to courier`}
              icon={Send}
              empty="Nothing waiting to go out."
            >
              {pending.length > 0
                ? pending.map((s) => <SampleCard key={s.id} sample={s} {...cardProps} />)
                : undefined}
            </Column>

            <Column
              title="At lab"
              subtitle={`${sent.length} awaiting results`}
              icon={FlaskConical}
              empty="No samples currently at the lab."
            >
              {sent.length > 0
                ? sent.map((s) => <SampleCard key={s.id} sample={s} {...cardProps} />)
                : undefined}
            </Column>

            <Column
              title="Results received"
              subtitle={isToday ? "Logged today" : formatDate(focusDate)}
              icon={CheckCircle2}
              action={dateNav}
              empty={isToday ? "No results logged yet today." : "No results logged on this day."}
            >
              {received.length > 0
                ? received.map((s) => <SampleCard key={s.id} sample={s} {...cardProps} />)
                : undefined}
            </Column>
          </div>

          {items.length === 0 && (
            <Card className="mt-6">
              <CardBody className="flex flex-col items-center gap-2 py-12 text-center">
                <TestTubes className="h-8 w-8 text-slate-300" />
                <p className="text-sm font-medium text-slate-600">No blood samples yet</p>
                <p className="max-w-md text-xs text-slate-400">
                  Entries appear here automatically when a doctor orders a blood collection
                  during a consultation. Then you can log the courier hand-off and results.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => router.push("/queue")}
                >
                  Go to today&apos;s queue
                </Button>
              </CardBody>
            </Card>
          )}

          <p className="mt-4 text-xs text-slate-400">
            Records are created automatically when a doctor orders blood work. The courier
            picks up once a day — “Awaiting send” and “At lab” always show every outstanding
            sample; the date arrows scope the “Results received” column. Click any time to adjust
            it. All changes save instantly.
          </p>
        </>
      )}
    </div>
  );
}
