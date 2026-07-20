"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, ChevronLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { FormRow, Input, Select, Textarea } from "@/components/ui/Field";
import { Loading, ErrorState } from "@/components/ui/States";
import { VisitBasketCard } from "@/components/VisitBasketCard";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { SUPPLEMENTS } from "@/lib/types";
import type {
  ClientPackage,
  ServicePriceKind,
  SessionPlan,
  VisitBasketItemKind,
} from "@/lib/types";
import { bmiCategory, calcBmi, cn, formatDate, formatMoney } from "@/lib/utils";
import { allocateCoverage } from "@/lib/coverage";

// ---- Visit services form state (local to the editor) ----
type TreatmentForm = {
  machine: string;
  machineOther: string;
  bodyParts: string[];
  bodyPartCustom: string;
  sessionsNeeded: string;
  sessionsUsed: string;
  clientPackageId: string;
  // Catalog bundle the dietitian is starting for this patient now: the full
  // bundle price is charged this visit and the sessions become prepaid.
  applyPackageId: string;
  // Pay-as-you-go session plan (separate from packages). `sessionPlan` marks the
  // treatment as drawing from a plan; `sessionPlanId` links an existing plan (a
  // new one is created on save when this is empty).
  sessionPlan: boolean;
  sessionPlanId: string;
  notes: string;
};

type ProductForm = { productId: string; quantity: string };

const EMPTY_TREATMENT: TreatmentForm = {
  machine: "",
  machineOther: "",
  bodyParts: [],
  bodyPartCustom: "",
  sessionsNeeded: "1",
  sessionsUsed: "1",
  clientPackageId: "",
  applyPackageId: "",
  // Treatments default to a single paid session (pay-as-you-go plan) unless a
  // package or bundle is chosen below.
  sessionPlan: true,
  sessionPlanId: "",
  notes: "",
};

const EMPTY_PRODUCT: ProductForm = { productId: "", quantity: "1" };

/**
 * Collapsible card section. Uncontrolled by default; pass `open`/`onOpenChange`
 * to control it externally (e.g. a side shortcut expanding it).
 */
function Section({
  title,
  subtitle,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) =>
    onOpenChange ? onOpenChange(next) : setInternalOpen(next);
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between bg-slate-50/60 px-4 py-3 text-left hover:bg-slate-50"
      >
        <div>
          <p className="text-sm font-medium text-slate-800">{title}</p>
          {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
        </div>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && <div className="border-t border-slate-100 px-4 py-4">{children}</div>}
    </div>
  );
}

/** Inline checkbox + label row. */
function CheckLine({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30"
      />
      <span className="min-w-0 flex-1">{label}</span>
    </label>
  );
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

const splitParts = (s: string) =>
  s.split(",").map((p) => p.trim()).filter(Boolean);

const toCount = (value: string | number | undefined, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};

const toAmount = (value: string | number | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

type BasketItem = {
  id: string;
  kind: VisitBasketItemKind;
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  currency: string;
  covered?: boolean;
  // For pay-as-you-go session lines: which treatment row produced them, so the
  // resolved session-plan id can be attached when sending/saving.
  treatmentIndex?: number;
};

function treatmentName(machine: string, machineOther?: string) {
  return machine === "Other" ? machineOther || "Other treatment" : machine;
}

function partsLabel(parts: string[]) {
  return parts.length > 0 ? parts.join(", ") : "General";
}

const EMPTY = {
  weight: "",
  height: "",
  waist: "",
  hips: "",
  bodyFat: "",
  muscle: "",
  goalWeight: "",
  clientGoals: "",
  notes: "",
  followUpPlan: "",
};

function ConsultationEditor() {
  const router = useRouter();
  const { toast } = useToast();
  const { user } = useSession();
  const params = useSearchParams();
  const clientId = params.get("client") ?? "";
  // When present, we're continuing an existing in-progress consultation (edit mode)
  // rather than starting a new one; saving updates it and adds only the new delta.
  const editId = params.get("consultation") ?? "";
  const [prefilled, setPrefilled] = useState(false);

  const { data, loading, error } = useApi(() => api.getClient(clientId), [clientId]);
  const staff = useApi(() => api.listStaff());
  const productCatalog = useApi(() => api.listProducts());
  const servicePrices = useApi(() => api.listServicePrices());
  const packageCatalog = useApi(() => api.listPackages());
  // This visit's basket, so "Close visit" can be blocked until the secretary
  // settles it (V-close rule). Polled with the page's other reads.
  const visitBaskets = useApi(() => api.listVisitBaskets());
  const sellableProducts = (productCatalog.data ?? []).filter((p) => p.active);
  // Multi-session catalog packages a dietitian can start for the patient now.
  // Fetched here so newly created packages are always current (no stale list).
  const activeBundles = (packageCatalog.data ?? []).filter(
    (p) => p.status === "active" && p.sessions > 1,
  );
  // Bundles offered for a given machine: only those scoped to that exact
  // treatment type. General/nutrition packages are never offered here — they are
  // assigned at signup, not started from within a machine treatment.
  const bundlesForMachine = (machine: string) =>
    activeBundles.filter((b) => b.machine === machine);

  // Treatment types (machines) are admin-managed in the ServicePrice catalog.
  // `treatmentTypes` is the full list — used to resolve prices and body-part
  // presets for treatments already on a visit, even if the type was later
  // deactivated. `activeTreatmentTypes` (Other kept last) is what a new treatment
  // may pick. `bodyPartsFor` returns a type's preset: undefined = free-text entry,
  // [] = no body-part field, [names] = fixed checklist.
  const treatmentTypes = (servicePrices.data ?? []).filter((p) => p.kind === "treatment");
  const activeTreatmentTypes = treatmentTypes
    .filter((p) => p.active)
    .sort(
      (a, b) =>
        (a.key === "Other" ? 1 : 0) - (b.key === "Other" ? 1 : 0) ||
        a.name.localeCompare(b.name),
    );
  const bodyPartsFor = (machine: string): string[] | undefined =>
    treatmentTypes.find((p) => p.key === machine)?.bodyParts;

  // Blood tests are admin-managed in the same catalog (like treatments). The
  // checklist offers every active test (Other kept last as the custom-name
  // bucket); `bloodTestKeys` recognises which stored names are known catalog
  // tests vs. custom "Other" entries when loading a saved visit.
  const bloodTestTypes = (servicePrices.data ?? []).filter((p) => p.kind === "blood_test");
  const activeBloodTests = bloodTestTypes
    .filter((p) => p.active)
    .sort(
      (a, b) =>
        (a.key === "Other" ? 1 : 0) - (b.key === "Other" ? 1 : 0) ||
        a.name.localeCompare(b.name),
    );
  const bloodTestKeys = new Set(bloodTestTypes.map((p) => p.key));

  const [form, setForm] = useState({ ...EMPTY });
  // Recommended supplements (multi-select) plus an optional free-text "Other".
  const [recoSupplements, setRecoSupplements] = useState<string[]>([]);
  const [recoOther, setRecoOther] = useState(false);
  const [recoOtherText, setRecoOtherText] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Basket sent to the secretary for payment (manual send). Polled so it flips
  // to "Paid" on the dietitian's screen once the secretary settles it.

  // ---- Visit services ----
  // Blood collection is implied by selecting one or more tests — the section
  // shows the tests directly, so there's no separate "required" toggle.
  const [bloodTests, setBloodTests] = useState<string[]>([]);
  const [bloodOther, setBloodOther] = useState("");
  const [nurseRequired, setNurseRequired] = useState(false);
  const [treatments, setTreatments] = useState<TreatmentForm[]>([]);
  const [treatmentsOpen, setTreatmentsOpen] = useState(false);
  const [products, setProducts] = useState<ProductForm[]>([]);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountType, setDiscountType] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  // The dietitian removed the auto-added consultation-fee line from this visit's
  // basket. Only affects this visit; the admin's configured fee is untouched.
  const [feeWaived, setFeeWaived] = useState(false);

  // ---- Recommended supplements: this dietitian's own editable options ----
  // The list is personal to the acting dietitian, so one dietitian's choices
  // never change another's. An unknown acting user (or an empty list) falls back
  // to the standard SUPPLEMENTS so the section always has usable options.
  const myStaff = (staff.data ?? []).find((s) => s.email === user?.email);
  const supplementOptions =
    myStaff && myStaff.supplements.length > 0 ? myStaff.supplements : [...SUPPLEMENTS];
  // Only a dietitian curates their own supplement list; other roles still see a
  // usable set (the fallback) but don't get the editor.
  const canManageSupplements = myStaff?.role === "dietitian";
  const [manageSuppOpen, setManageSuppOpen] = useState(false);
  const [suppDraft, setSuppDraft] = useState<string[]>([]);
  const [newSupp, setNewSupp] = useState("");
  const [savingSupp, setSavingSupp] = useState(false);

  function openManageSupplements() {
    setSuppDraft(supplementOptions);
    setNewSupp("");
    setManageSuppOpen(true);
  }

  function addDraftSupplement() {
    const value = newSupp.trim();
    if (!value) return;
    if (suppDraft.some((s) => s.toLowerCase() === value.toLowerCase())) {
      setNewSupp("");
      return;
    }
    setSuppDraft((prev) => [...prev, value]);
    setNewSupp("");
  }

  async function saveSupplements() {
    if (!myStaff) return;
    setSavingSupp(true);
    try {
      const updated = await api.updateStaffSupplements(myStaff.id, suppDraft);
      // Drop any ticked recommendations that were just removed from the list.
      setRecoSupplements((prev) => prev.filter((s) => updated.supplements.includes(s)));
      staff.refetch();
      setManageSuppOpen(false);
      toast("Supplement list updated");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSavingSupp(false);
    }
  }

  function updateTreatment(i: number, patch: Partial<TreatmentForm>) {
    setTreatments((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }

  // Side shortcut: draw a session from a remaining-balance package. Repeated
  // clicks stack onto the same treatment (one line, session count grows) rather
  // than adding duplicate rows — coverage is then capped at the package balance,
  // and any sessions beyond it are charged at the per-session price.
  function addTreatmentFromPackage(pkg: ClientPackage) {
    const remaining = pkg.totalSessions - pkg.usedSessions;
    setTreatments((prev) => {
      const existingIndex = prev.findIndex(
        (t) => t.clientPackageId === pkg.id && !t.applyPackageId,
      );
      if (existingIndex >= 0) {
        return prev.map((t, idx) =>
          idx === existingIndex
            ? { ...t, sessionsUsed: String(toCount(t.sessionsUsed, 0) + 1) }
            : t,
        );
      }
      return [
        ...prev,
        {
          ...EMPTY_TREATMENT,
          machine: pkg.machine ?? "",
          clientPackageId: pkg.id,
          sessionPlan: false,
          sessionsNeeded: String(Math.max(1, remaining)),
        },
      ];
    });
    setTreatmentsOpen(true);
    toast(`${pkg.machine ?? pkg.packageName} session added — adjust it below`);
  }

  // Quick-add a treatment drawing from a pay-as-you-go session plan (separate from
  // packages). Stacks onto an existing row for the same plan; prepaid credit
  // auto-covers what it can and the rest is charged at the plan's price.
  function addTreatmentFromSessionPlan(plan: SessionPlan) {
    setTreatments((prev) => {
      const existingIndex = prev.findIndex((t) => t.sessionPlan && t.sessionPlanId === plan.id);
      if (existingIndex >= 0) {
        return prev.map((t, idx) =>
          idx === existingIndex
            ? { ...t, sessionsUsed: String(toCount(t.sessionsUsed, 0) + 1) }
            : t,
        );
      }
      return [
        ...prev,
        {
          ...EMPTY_TREATMENT,
          machine: plan.machine ?? "",
          sessionPlan: true,
          sessionPlanId: plan.id,
          sessionsNeeded: String(Math.max(1, plan.sessionsNeeded)),
        },
      ];
    });
    setTreatmentsOpen(true);
    toast(`${plan.machine ?? "Session plan"} session added — adjust it below`);
  }

  function updateProduct(i: number, patch: Partial<ProductForm>) {
    setProducts((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  // When continuing an existing draft, don't count it as a prior visit, and show
  // its real visit number instead of computing a new one.
  const editingConsult = editId ? (data?.consultations ?? []).find((c) => c.id === editId) : undefined;
  const prevAll = (data?.consultations ?? []).filter((c) => c.id !== editId);
  const prev = prevAll[prevAll.length - 1];
  const visitNumber = editingConsult ? editingConsult.visitNumber : prevAll.length + 1;

  // Default height to the last recorded value once data arrives.
  const height = form.height || (prev?.heightCm ? String(prev.heightCm) : "");

  const bmi = useMemo(
    () => calcBmi(Number(form.weight) || undefined, Number(height) || undefined),
    [form.weight, height],
  );
  const delta =
    prev?.weightKg && Number(form.weight)
      ? (Number(form.weight) - prev.weightKg).toFixed(1)
      : null;

  // Landing on "new consultation" for a client who already has an in-progress
  // visit: continue that draft instead of forking a second one (which would mint a
  // duplicate visit number, frozen fee, and basket — the server refuses it too).
  // Redirect into the open visit and tell the user why they're looking at one they
  // didn't just start. Ref-guarded so it fires once while the URL swap settles.
  const redirectedToDraftRef = useRef(false);
  useEffect(() => {
    if (editId || redirectedToDraftRef.current || !data) return;
    const draft = data.consultations.find((c) => c.status === "open");
    if (!draft) return;
    redirectedToDraftRef.current = true;
    toast("This client already has an in-progress visit — continuing it instead of starting a new one.");
    router.replace(`/consultations/new?client=${clientId}&consultation=${draft.id}`);
  }, [editId, data, clientId, router, toast]);
  const redirectingToDraft =
    !editId && !!(data?.consultations ?? []).find((c) => c.status === "open");

  // Continuing an in-progress consultation: prefill the form from it, once.
  // Wait for the treatment catalog so body-part presets resolve when splitting a
  // saved treatment's parts into checklist vs free-text.
  useEffect(() => {
    if (prefilled || !editId || !data || !servicePrices.data) return;
    const c = data.consultations.find((x) => x.id === editId);
    if (!c) return;
    setForm({
      weight: c.weightKg != null ? String(c.weightKg) : "",
      height: c.heightCm != null ? String(c.heightCm) : "",
      waist: c.waistCm != null ? String(c.waistCm) : "",
      hips: c.hipsCm != null ? String(c.hipsCm) : "",
      bodyFat: c.bodyFatPercent != null ? String(c.bodyFatPercent) : "",
      muscle: c.muscleMassKg != null ? String(c.muscleMassKg) : "",
      goalWeight: c.goalWeightKg != null ? String(c.goalWeightKg) : "",
      clientGoals: c.clientGoals ?? "",
      notes: c.notes ?? "",
      followUpPlan: c.followUpPlan ?? "",
    });
    setBloodTests(
      (c.bloodTests ?? []).map((t) => (bloodTestKeys.has(t) ? t : "Other")),
    );
    const customBlood = (c.bloodTests ?? []).find((t) => !bloodTestKeys.has(t));
    if (customBlood) setBloodOther(customBlood);
    if (c.visitDiscountType && (c.visitDiscountValue ?? 0) > 0) {
      setDiscountOpen(true);
      setDiscountType(c.visitDiscountType);
      setDiscountValue(String(c.visitDiscountValue));
      setDiscountReason(c.visitDiscountReason ?? "");
    }
    setFeeWaived(c.consultationFeeWaived ?? false);
    setTreatments(
      (c.treatments ?? []).map((t) => {
        const preset = bodyPartsFor(t.machine);
        const presetParts = preset ? t.bodyParts.filter((p) => preset.includes(p)) : [];
        const customParts = t.bodyParts.filter((p) => !presetParts.includes(p));
        return {
          ...EMPTY_TREATMENT,
          machine: t.machine,
          machineOther: t.machineOther ?? "",
          bodyParts: customParts.length > 0 ? [...presetParts, "Other"] : presetParts,
          bodyPartCustom: customParts.join(", "),
          sessionsNeeded: String(t.sessionsNeeded),
          sessionsUsed: String(t.sessionsUsed),
          clientPackageId: t.clientPackageId ?? "",
          // Anything not drawn from a package is a single paid session (pay-as-you-go);
          // older "no package" treatments re-open in that mode too.
          sessionPlan: !t.clientPackageId,
          sessionPlanId: t.sessionPlanId ?? "",
        };
      }),
    );
    setProducts(
      (c.products ?? [])
        .map((p) => {
          // Prefer the permanent productId captured at sale — it survives the
          // catalog product being renamed or deleted. Fall back to a name match
          // only for legacy rows saved before productId existed.
          const id =
            p.productId ?? (productCatalog.data ?? []).find((sp) => sp.name === p.name)?.id;
          return id ? { productId: id, quantity: String(p.quantity) } : null;
        })
        .filter((p): p is { productId: string; quantity: string } => p !== null),
    );
    if ((c.treatments ?? []).length > 0) setTreatmentsOpen(true);
    setPrefilled(true);
  }, [editId, data, prefilled, productCatalog.data, servicePrices.data]);

  if (loading || redirectingToDraft) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <p className="text-slate-400">Client not found.</p>;

  // A closed visit is a finalized, read-only record — the server rejects any edit
  // to it. If one is ever opened in the editor (a stale link, a hand-typed URL,
  // a future entry point), don't render the editable form and its Save/Close
  // controls; show a read-only notice and point to the profile, where the full
  // visit is displayed read-only. This is the UI half of the server's own guard.
  if (editingConsult && editingConsult.status === "closed") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h2 className="text-xl font-semibold text-slate-900">Visit closed</h2>
        <p className="mt-2 text-sm text-slate-500">
          Visit #{editingConsult.visitNumber} for {data.client.firstName} {data.client.lastName} is
          finalized and read-only — closed visits can&apos;t be edited. Open the client profile to
          review it.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => router.push(`/clients/${data.client.id}`)}>
            View on client profile
          </Button>
          <Button variant="outline" onClick={() => router.push("/queue")}>
            Back to queue
          </Button>
        </div>
      </div>
    );
  }

  // A consultation can't start until the patient's check-in details are complete.
  if (!data.client.intakeComplete) {
    const back = encodeURIComponent(`/consultations/new?client=${data.client.id}`);
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h2 className="text-xl font-semibold text-slate-900">Check-in required</h2>
        <p className="mt-2 text-sm text-slate-500">
          {data.client.firstName} {data.client.lastName} hasn&apos;t been checked in yet.
          Complete the required registration details before starting the consultation.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => router.push(`/clients/${data.client.id}/checkin?return=${back}`)}>
            Complete check-in
          </Button>
          <Button variant="outline" onClick={() => router.push(`/clients/${data.client.id}`)}>
            Back to profile
          </Button>
        </div>
      </div>
    );
  }

  const client = data.client;
  // Package balances are consumed via treatments below (drawing from a machine
  // bundle). Nothing is auto-deducted.
  const num = (v: string) => (v ? Number(v) : undefined);
  const servicePriceFor = (kind: ServicePriceKind, key: string) =>
    (servicePrices.data ?? []).find((p) => p.kind === kind && p.key === key && p.active);
  const servicePriceText = (kind: ServicePriceKind, key: string) => {
    const price = servicePriceFor(kind, key);
    return price ? formatMoney(price.price, price.currency) : "Price not set";
  };
  const treatmentPriceFor = (machine: string) =>
    servicePriceFor("treatment", machine === "Other" ? "Other" : machine);
  const bloodPriceFor = (name: string) =>
    servicePriceFor("blood_test", bloodTestKeys.has(name) ? name : "Other");
  // The checklist offers every active test, plus any already-selected test that
  // was deactivated after being added (so it stays visible and removable).
  const bloodTestOptions = [
    ...activeBloodTests.map((p) => ({ key: p.key, name: p.name })),
    ...bloodTests
      .filter((k) => k !== "Other" && !activeBloodTests.some((p) => p.key === k))
      .map((k) => ({ key: k, name: bloodTestTypes.find((p) => p.key === k)?.name ?? k })),
  ];

  // Pay-as-you-go session plans (separate from packages). The plan a session
  // treatment draws from: its explicitly linked plan, or any active plan for the
  // same machine (a brand-new one is created on save when none exists).
  const sessionPlans = data.sessionPlans;
  const linkedSessionPlan = (t: TreatmentForm): SessionPlan | undefined => {
    if (!t.sessionPlan) return undefined;
    if (t.sessionPlanId) return sessionPlans.find((p) => p.id === t.sessionPlanId);
    return sessionPlans.find((p) => p.status === "active" && (p.machine ?? "") === t.machine);
  };

  function treatmentPartsForForm(t: TreatmentForm) {
    const preset = bodyPartsFor(t.machine);
    if (preset) {
      const parts = t.bodyParts.filter((p) => p !== "Other");
      if (t.bodyParts.includes("Other")) parts.push(...splitParts(t.bodyPartCustom));
      return parts;
    }
    return splitParts(t.bodyPartCustom);
  }

  // Active packages carrying remaining sessions for a given machine — these are
  // the carried-over balances a returning patient can draw from.
  const machinePackagesFor = (machine: string): ClientPackage[] =>
    client.packages.filter(
      (p) =>
        p.status === "active" &&
        p.machine === machine &&
        p.totalSessions - p.usedSessions > 0,
    );

  // Machine bundles with sessions left — surfaced as quick-add treatment shortcuts.
  const sessionPackages = client.packages.filter(
    (p) => p.status === "active" && p.machine && p.totalSessions - p.usedSessions > 0,
  );
  // Session plans carrying prepaid credit — surfaced in "Sessions available" too.
  const creditPlans = sessionPlans.filter((p) => p.status === "active" && p.credit > 0);

  // How many of each treatment's sessions are covered (free) vs charged.
  // Coverage is capped at each package/bundle's remaining balance and allocated
  // across treatments in order, so sessions beyond the balance are billed at the
  // per-session price instead of being free.
  // Resolve each treatment's coverage source and seed its remaining balance, then
  // split covered vs charged through the shared allocator (same kernel the server
  // bills with). Session plans draw prepaid credit; bundles/packages draw balance.
  const remainingBySource = new Map<string, number>();
  const coverageRows = treatments.map((t) => {
    const used = toCount(t.sessionsUsed, 0);
    let sourceKey: string | null = null;
    if (t.sessionPlan) {
      const plan = linkedSessionPlan(t);
      if (plan) {
        sourceKey = `s:${plan.id}`;
        if (!remainingBySource.has(sourceKey)) remainingBySource.set(sourceKey, plan.credit);
      }
    } else if (t.applyPackageId) {
      sourceKey = `b:${t.applyPackageId}`;
      if (!remainingBySource.has(sourceKey)) {
        const b = activeBundles.find((x) => x.id === t.applyPackageId);
        remainingBySource.set(sourceKey, b ? b.sessions : 0);
      }
    } else if (t.clientPackageId) {
      sourceKey = t.clientPackageId;
      if (!remainingBySource.has(sourceKey)) {
        const p = client.packages.find((x) => x.id === t.clientPackageId);
        remainingBySource.set(sourceKey, p ? Math.max(0, p.totalSessions - p.usedSessions) : 0);
      }
    }
    return { sourceKey, used };
  });
  const treatmentCoverage = allocateCoverage(coverageRows, remainingBySource);

  // Flatten blood-test selection, expanding the custom "Other" entry. Blood
  // collection is "ordered" whenever at least one test is selected.
  const finalBloodTests = [
    ...bloodTests.filter((t) => t !== "Other"),
    ...(bloodTests.includes("Other") && bloodOther.trim() ? [bloodOther.trim()] : []),
  ];
  const bloodCollection = finalBloodTests.length > 0;

  // Build saved treatment entries, resolving preset vs free-text body parts.
  // Treatment payload, tagging session-plan treatments with their resolved plan id.
  const buildTreatments = (planIds: Map<number, string>) =>
    treatments
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.machine)
      .map(({ t, i }) => {
        const parts = treatmentPartsForForm(t);
        return {
          machine: t.machine,
          machineOther: t.machine === "Other" ? t.machineOther || undefined : undefined,
          bodyParts: parts,
          sessionsNeeded: t.sessionsNeeded ? Number(t.sessionsNeeded) : 1,
          sessionsUsed: t.sessionsUsed ? Number(t.sessionsUsed) : 0,
          clientPackageId: t.sessionPlan ? null : t.clientPackageId || null,
          applyPackageId: t.sessionPlan ? null : t.applyPackageId || null,
          sessionPlanId: t.sessionPlan ? planIds.get(i) ?? null : null,
          notes: t.notes || undefined,
        };
      });

  // Ensure every session-plan treatment has a real plan: link an existing active
  // plan for its machine, or create one now (per-session price from the catalog).
  // Returns a map of treatment index → plan id, and records new ids on the form
  // so a later save/send reuses them instead of creating duplicates.
  async function ensureSessionPlans(): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const byMachine = new Map<string, string>();
    for (let i = 0; i < treatments.length; i++) {
      const t = treatments[i];
      if (!t.sessionPlan || !t.machine) continue;
      const linked = linkedSessionPlan(t);
      if (linked) { map.set(i, linked.id); byMachine.set(t.machine, linked.id); continue; }
      if (byMachine.has(t.machine)) { map.set(i, byMachine.get(t.machine)!); continue; }
      // F4: price/currency are snapshotted server-side from the catalog by machine,
      // never sent from here — so this can't set an off-catalog per-session price.
      const created = await api.createSessionPlan({
        clientId,
        machine: t.machine,
        sessionsNeeded: Math.max(1, toCount(t.sessionsNeeded, 1)),
      });
      map.set(i, created.id);
      byMachine.set(t.machine, created.id);
    }
    if (map.size > 0) {
      setTreatments((prev) =>
        prev.map((t, i) =>
          t.sessionPlan && !t.sessionPlanId && map.has(i) ? { ...t, sessionPlanId: map.get(i)! } : t,
        ),
      );
    }
    return map;
  }

  // Products sold on THIS consultation, snapshotted by permanent id — lets a line
  // still render/price after its catalog product is renamed (id stable) or deleted
  // (falls back to this frozen snapshot).
  const editConsultation = editId ? data.consultations.find((x) => x.id === editId) : undefined;
  const soldProductSnapshots = new Map(
    (editConsultation?.products ?? [])
      .filter((p) => p.productId)
      .map((p) => [
        p.productId!,
        {
          name: p.name,
          // Use the frozen per-unit price directly (no amount ÷ quantity drift);
          // fall back to division only for legacy rows that never stored one.
          price: p.unitPrice ?? (p.quantity > 0 ? p.amount / p.quantity : p.amount),
          currency: p.currency ?? "USD",
        },
      ]),
  );
  // Resolve a line's display name/price. A line already sold on this consultation
  // ALWAYS uses its frozen sale-time snapshot (never re-priced/renamed from the live
  // catalog, whether the product was later renamed, re-priced, or deleted). Only a
  // brand-new line reads the live catalog (its true price at time of sale).
  const resolveProductLine = (productId: string) => {
    const snap = soldProductSnapshots.get(productId);
    if (snap) return { name: snap.name, price: snap.price, currency: snap.currency };
    const live = sellableProducts.find((sp) => sp.id === productId);
    if (live) return { name: live.name, price: live.price, currency: live.currency };
    return undefined;
  };

  // F4: send only the catalog id + quantity — the server snapshots name/price/
  // currency (from the live catalog, or this consultation's frozen snapshot when
  // the catalog product was deleted), so a tampered request can't set the price.
  const finalProducts = products
    .filter((p) => Boolean(resolveProductLine(p.productId)))
    .map((p) => ({
      productId: p.productId,
      quantity: p.quantity ? Number(p.quantity) : 1,
    }));

  const productBasketItems = products.reduce<BasketItem[]>((items, p, i) => {
    const info = resolveProductLine(p.productId);
    if (!info) return items;
    const quantity = toCount(p.quantity, 1);
    items.push({
      id: `product-${i}`,
      kind: "product",
      label: info.name,
      detail: "Product",
      quantity,
      unitPrice: info.price,
      amount: info.price * quantity,
      currency: info.currency,
    });
    return items;
  }, []);

  // Starting a bundle for the patient bills the full bundle price once this
  // visit (its sessions are then prepaid). One line per applied bundle.
  const bundleBasketItems = treatments.reduce<BasketItem[]>((items, t, i) => {
    if (!t.machine || !t.applyPackageId) return items;
    const bundle = activeBundles.find((b) => b.id === t.applyPackageId);
    if (!bundle) return items;
    const net = Math.round(bundle.price * (1 - bundle.discountPercent / 100));
    items.push({
      id: `bundle-${i}-${bundle.id}`,
      kind: "custom",
      label: bundle.name,
      detail: `Bundle · ${bundle.sessions} sessions`,
      quantity: 1,
      unitPrice: net,
      amount: net,
      currency: bundle.currency,
    });
    return items;
  }, []);

  // Consultation fee preview. For a NEW visit it's the acting dietitian's live
  // configured fee; when continuing an existing visit it's the amount frozen onto
  // that consultation (never the live fee). The dietitian can remove it (feeWaived)
  // for this visit only.
  const consultationFeeAmount = editId
    ? editingConsult?.consultationFee ?? 0
    : myStaff?.consultationFee ?? 0;
  const consultationFeeDietitian = editId ? editingConsult?.dietitianName : myStaff?.fullName;
  const showConsultationFee = consultationFeeAmount > 0 && !feeWaived;

  const basketItems: BasketItem[] = [
    ...(showConsultationFee
      ? [
          {
            id: "consultation-fee",
            kind: "custom" as const,
            label: "Consultation fee",
            detail: consultationFeeDietitian,
            quantity: 1,
            unitPrice: consultationFeeAmount,
            amount: consultationFeeAmount,
            currency: "USD",
          },
        ]
      : []),
    ...finalBloodTests.map((name, i) => {
      const price = bloodPriceFor(name);
      return {
        id: `blood-${i}-${name}`,
        kind: "blood_test" as const,
        label: name,
        detail: "Blood test",
        quantity: 1,
        unitPrice: price?.price ?? 0,
        amount: price?.price ?? 0,
        currency: price?.currency ?? "USD",
      };
    }),
    ...treatments.flatMap((t, i) => {
      if (!t.machine || toCount(t.sessionsUsed, 0) <= 0) return [];
      const price = treatmentPriceFor(t.machine);
      const unit = price?.price ?? 0;
      const cur = price?.currency ?? "USD";
      const parts = partsLabel(treatmentPartsForForm(t));
      const { covered, charged } = treatmentCoverage[i] ?? { covered: 0, charged: 0 };
      // Session-plan treatments cover from prepaid credit; packages/bundles from balance.
      const coveredBy = t.sessionPlan ? "credit" : "bundle";
      const lines: BasketItem[] = [];
      // Covered sessions: tracked but not charged (capped at the remaining balance/credit).
      if (covered > 0) {
        lines.push({
          id: `treatment-${i}-covered`,
          kind: "treatment",
          label: treatmentName(t.machine, t.machineOther),
          detail: `${parts} · ${covered} covered by ${coveredBy}`,
          quantity: covered,
          unitPrice: unit,
          amount: 0,
          currency: cur,
          covered: true,
          treatmentIndex: i,
        });
      }
      // Sessions beyond the balance/credit (or with no source): charged per session.
      if (charged > 0) {
        lines.push({
          id: `treatment-${i}-charged`,
          kind: "treatment",
          label: treatmentName(t.machine, t.machineOther),
          detail: `${parts} · ${charged} charged`,
          quantity: charged,
          unitPrice: unit,
          amount: unit * charged,
          currency: cur,
          covered: false,
          treatmentIndex: i,
        });
      }
      return lines;
    }),
    ...bundleBasketItems,
    ...productBasketItems,
  ];

  // Discount value persisted on save / sent to the secretary (percent capped at
  // 100). The basket card computes its own subtotal/discount/total for display.
  const rawDiscountValue = discountOpen ? toAmount(discountValue) : 0;
  const discountValueForSave =
    discountType === "percent" ? Math.min(rawDiscountValue, 100) : rawDiscountValue;
  // A reason is mandatory once an actual discount amount is entered.
  const discountReasonMissing = discountValueForSave > 0 && !discountReason.trim();

  // Recommendations = the ticked supplements plus any free-text "Other", saved
  // as a single comma-separated string (the field is free text in the model).
  const recommendationsText = [
    ...recoSupplements,
    ...(recoOther && recoOtherText.trim() ? [recoOtherText.trim()] : []),
  ].join(", ");

  // Save the visit. `close` finalizes it (no more edits); otherwise it stays an
  // open, in-progress draft that can be re-opened and settled in installments.
  // When editing an existing open consultation, this updates it (delta only).
  async function save(close: boolean) {
    if (discountReasonMissing) {
      toast("Please add a reason for the discount.");
      return;
    }
    setSaving(true);
    try {
      const me = (staff.data ?? []).find((s) => s.email === user?.email);
      const planIds = await ensureSessionPlans();
      const payload = {
        clientId,
        dietitianId: me?.id ?? null,
        close,
        weightKg: num(form.weight),
        heightCm: num(height),
        waistCm: num(form.waist),
        hipsCm: num(form.hips),
        bodyFatPercent: num(form.bodyFat),
        muscleMassKg: num(form.muscle),
        goalWeightKg: num(form.goalWeight),
        clientGoals: form.clientGoals || undefined,
        notes: form.notes || undefined,
        recommendations: recommendationsText || undefined,
        followUpPlan: form.followUpPlan || undefined,
        bloodCollection,
        bloodTests: finalBloodTests,
        nurseRequired,
        visitDiscountType: discountOpen && discountValueForSave > 0 ? discountType : undefined,
        visitDiscountValue: discountOpen ? discountValueForSave : undefined,
        visitDiscountReason:
          discountOpen && discountValueForSave > 0 ? discountReason.trim() : undefined,
        visitDiscountCurrency: discountOpen && discountType === "amount" ? ("USD" as const) : undefined,
        waiveConsultationFee: feeWaived,
        treatments: buildTreatments(planIds),
        products: finalProducts,
      };
      if (editId) await api.updateConsultation(editId, payload);
      else await api.createConsultation(payload);
      toast(close ? "Visit closed" : "Saved — visit in progress");
      setSaved(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ---- Close / delete gating (V-close rule) ----
  // A visit can't be closed until the secretary settles its basket. Block while a
  // pending basket exists, or when there are charges that were never sent for
  // payment (a fresh visit, or one whose charges aren't on a basket yet).
  const hasChargeableItems = basketItems.some((i) => !i.covered);
  const consultBasket = editId
    ? (visitBaskets.data ?? []).find((b) => b.consultationId === editId)
    : undefined;
  const basketPending = consultBasket?.status === "pending";
  const closeBlocked = basketPending || (hasChargeableItems && !consultBasket);
  const closeBlockedReason = basketPending
    ? "Waiting for the secretary to settle this visit's basket."
    : "Save & send the basket for payment first — the secretary settles it, then you can close.";

  // Delete is the escape hatch for a visit opened by mistake — available on an
  // open (not-yet-closed) visit; the server enforces owner/admin + money guards.
  const canDelete = Boolean(editId) && editingConsult != null && editingConsult.status !== "closed";

  async function handleDelete() {
    if (!editId) return;
    setDeleting(true);
    try {
      await api.deleteConsultation(editId);
      toast("Consultation deleted");
      router.push(`/clients/${clientId}`);
    } catch (e) {
      toast((e as Error).message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (saved) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <Check className="h-8 w-8" />
        </div>
        <h2 className="mt-5 text-xl font-semibold text-slate-900">Consultation saved</h2>
        <p className="mt-2 text-sm text-slate-500">
          Visit #{visitNumber} recorded for {client.firstName}.{" "}
          Any machine sessions used were deducted from their bundles.
          {basketItems.some((i) => !i.covered) &&
            " The visit basket was sent to the secretary for payment."}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => router.push(`/clients/${client.id}`)}>Open client profile</Button>
          <Button variant="outline" onClick={() => router.push("/queue")}>Back to queue</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => router.back()}
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>
      <PageHeader
        title={`${editId ? "Continue consultation" : "New consultation"} — ${client.firstName} ${client.lastName}`}
        subtitle={`Visit #${visitNumber} · ${client.assignedDietitian ?? "Dietitian"}`}
      />

      {!client.hasMedicalHistory && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">Medical history needs to be taken.</span> Capture the full
          medical history and baseline measurements for this visit.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Measurements" subtitle="BMI is calculated automatically." />
            <CardBody className="grid gap-4 sm:grid-cols-3">
              <FormRow label="Weight (kg)">
                <Input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} placeholder="e.g. 70.5" />
              </FormRow>
              <FormRow label="Height (cm)">
                <Input type="number" value={height} onChange={(e) => setForm({ ...form, height: e.target.value })} placeholder="e.g. 165" />
              </FormRow>
              <FormRow label="BMI (auto)">
                <div className="flex h-10 items-center rounded-lg bg-slate-50 px-3 text-sm">
                  {bmi ? (
                    <span className="font-medium text-slate-800">{bmi} <span className="font-normal text-slate-400">· {bmiCategory(bmi)}</span></span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </div>
              </FormRow>
              <FormRow label="Waist (cm)"><Input type="number" value={form.waist} onChange={(e) => setForm({ ...form, waist: e.target.value })} /></FormRow>
              <FormRow label="Hips (cm)"><Input type="number" value={form.hips} onChange={(e) => setForm({ ...form, hips: e.target.value })} /></FormRow>
              <FormRow label="Body fat (%)"><Input type="number" value={form.bodyFat} onChange={(e) => setForm({ ...form, bodyFat: e.target.value })} /></FormRow>
              <FormRow label="Muscle mass (kg)"><Input type="number" value={form.muscle} onChange={(e) => setForm({ ...form, muscle: e.target.value })} /></FormRow>
              <FormRow label="Goal weight (kg)"><Input type="number" value={form.goalWeight} onChange={(e) => setForm({ ...form, goalWeight: e.target.value })} placeholder={prev?.goalWeightKg ? String(prev.goalWeightKg) : ""} /></FormRow>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Consultation notes" />
            <CardBody className="space-y-4">
              <FormRow label="Client goals"><Textarea rows={2} value={form.clientGoals} onChange={(e) => setForm({ ...form, clientGoals: e.target.value })} /></FormRow>
              <FormRow label="Dietitian notes"><Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Observations, adherence, discussion…" /></FormRow>
              <FormRow label="Recommended supplements">
                {canManageSupplements && (
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs text-slate-400">Your personal list — changes only affect your consultations.</p>
                    <button
                      type="button"
                      onClick={openManageSupplements}
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Manage list
                    </button>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {supplementOptions.map((s) => (
                    <CheckLine
                      key={s}
                      checked={recoSupplements.includes(s)}
                      onChange={() => setRecoSupplements((prev) => toggle(prev, s))}
                      label={s}
                    />
                  ))}
                  <CheckLine checked={recoOther} onChange={setRecoOther} label="Other" />
                </div>
              </FormRow>
              {recoOther && (
                <FormRow label="Other recommendation">
                  <Textarea
                    rows={2}
                    value={recoOtherText}
                    onChange={(e) => setRecoOtherText(e.target.value)}
                    placeholder="Diet, activity, hydration, custom supplement…"
                  />
                </FormRow>
              )}
              <FormRow label="Follow-up plan"><Input value={form.followUpPlan} onChange={(e) => setForm({ ...form, followUpPlan: e.target.value })} placeholder="e.g. Review in 2 weeks" /></FormRow>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Visit services"
              subtitle="Optional — open only the parts you need for this visit."
            />
            <CardBody className="space-y-3">
              {/* Nurse needed — single tick, no dropdown */}
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <label className="flex cursor-pointer items-center gap-3 bg-slate-50/60 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={nurseRequired}
                    onChange={(e) => setNurseRequired(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30"
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Nurse needed</span>
                    <span className="block text-xs text-slate-400">Flag nurse support for this visit.</span>
                  </span>
                </label>
              </div>

              {/* 1. Blood collection */}
              <Section title="Blood collection" subtitle="Order lab tests for this visit.">
                <div className="space-y-3">
                  <p className="text-xs font-medium text-slate-500">Select the tests to order</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {bloodTestOptions.map((t) => (
                      <CheckLine
                        key={t.key}
                        checked={bloodTests.includes(t.key)}
                        onChange={() => setBloodTests((prev) => toggle(prev, t.key))}
                        label={
                          <span className="flex items-center justify-between gap-3">
                            <span>{t.name}</span>
                            <span className="shrink-0 text-xs font-medium text-slate-400">
                              {servicePriceText("blood_test", t.key)}
                            </span>
                          </span>
                        }
                      />
                    ))}
                  </div>
                  {bloodTests.includes("Other") && (
                    <FormRow label="Custom test name">
                      <Input value={bloodOther} onChange={(e) => setBloodOther(e.target.value)} placeholder="e.g. Vitamin D panel" />
                    </FormRow>
                  )}
                </div>
              </Section>

              {/* 3 + 4. Services / treatments and packages & sessions */}
              <Section
                title="Services / treatments"
                subtitle="Machines, body parts and session usage."
                open={treatmentsOpen}
                onOpenChange={setTreatmentsOpen}
              >
                <div className="space-y-4">
                  {treatments.length === 0 && (
                    <p className="text-sm text-slate-400">No treatments added.</p>
                  )}
                  {treatments.map((t, i) => {
                    const preset = bodyPartsFor(t.machine);
                    // Hide the body-part field for machines that don't treat a
                    // specific area (an empty preset, e.g. Red Light Therapy).
                    const showBodyParts = !preset || preset.length > 0;
                    const pkgs = t.machine ? machinePackagesFor(t.machine) : [];
                    const selectedPkg = pkgs.find((p) => p.id === t.clientPackageId);
                    // A catalog bundle the dietitian is starting for this patient
                    // now: charged in full this visit, then its sessions are prepaid.
                    const appliedBundle = t.applyPackageId
                      ? activeBundles.find((b) => b.id === t.applyPackageId)
                      : undefined;
                    const bundleCharge = appliedBundle
                      ? Math.round(appliedBundle.price * (1 - appliedBundle.discountPercent / 100))
                      : 0;
                    const sessionsUsed = toCount(t.sessionsUsed, 0);
                    // Sessions covered (free) vs charged for this treatment, with
                    // coverage capped at the package/bundle's remaining balance.
                    const { covered: coveredSessions, charged: chargedSessions } =
                      treatmentCoverage[i] ?? { covered: 0, charged: sessionsUsed };
                    const hasSource = Boolean(t.clientPackageId || t.applyPackageId);
                    const treatmentPrice = t.machine ? treatmentPriceFor(t.machine) : undefined;
                    // Pay-as-you-go session plan linked to this treatment (if any).
                    const sessionPlan = t.sessionPlan ? linkedSessionPlan(t) : undefined;
                    const sessionCredit = sessionPlan?.credit ?? 0;
                    return (
                      <div key={i} className="space-y-3 rounded-lg border border-slate-200 p-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-slate-700">Treatment {i + 1}</p>
                          <button
                            type="button"
                            onClick={() => setTreatments((prev) => prev.filter((_, idx) => idx !== i))}
                            className="text-slate-400 hover:text-rose-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <FormRow label="Machine / treatment">
                            <Select
                              value={t.machine}
                              onChange={(e) =>
                                updateTreatment(i, {
                                  machine: e.target.value,
                                  bodyParts: [],
                                  bodyPartCustom: "",
                                  clientPackageId: "",
                                  applyPackageId: "",
                                  // Re-link the session plan to the new machine (plans are per-machine).
                                  sessionPlanId: "",
                                })
                              }
                            >
                              <option value="">Select…</option>
                              {/* A type recorded earlier but since deactivated still
                                  appears so this row keeps its value; new picks are
                                  limited to active types. */}
                              {t.machine &&
                                !activeTreatmentTypes.some((p) => p.key === t.machine) && (
                                  <option value={t.machine}>
                                    {treatmentTypes.find((p) => p.key === t.machine)?.name ??
                                      t.machine}{" "}
                                    (inactive)
                                  </option>
                                )}
                              {activeTreatmentTypes.map((p) => (
                                <option key={p.id} value={p.key}>
                                  {p.name}
                                </option>
                              ))}
                            </Select>
                          </FormRow>
                          {t.machine === "Other" && (
                            <FormRow label="Custom machine name">
                              <Input value={t.machineOther} onChange={(e) => updateTreatment(i, { machineOther: e.target.value })} />
                            </FormRow>
                          )}
                        </div>

                        {!t.machine && activeBundles.length > 0 && (
                          <p className="text-xs text-slate-400">
                            Pick a machine to draw from the patient&apos;s bundle or start a new one
                            ({activeBundles.length} available).
                          </p>
                        )}

                        {t.machine && (
                          <>
                            <p className="text-sm text-slate-500">
                              Catalog price:{" "}
                              <span className="font-medium text-slate-700">
                                {treatmentPrice
                                  ? formatMoney(treatmentPrice.price, treatmentPrice.currency)
                                  : "Price not set"}
                              </span>
                            </p>

                            {showBodyParts && (
                              <div>
                                <p className="mb-1.5 text-xs font-medium text-slate-500">Body part(s)</p>
                                {preset ? (
                                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                                    {preset.map((bp) => (
                                      <CheckLine
                                        key={bp}
                                        checked={t.bodyParts.includes(bp)}
                                        onChange={() => updateTreatment(i, { bodyParts: toggle(t.bodyParts, bp) })}
                                        label={bp}
                                      />
                                    ))}
                                  </div>
                                ) : (
                                  <Input
                                    value={t.bodyPartCustom}
                                    onChange={(e) => updateTreatment(i, { bodyPartCustom: e.target.value })}
                                    placeholder="Body parts (comma separated)"
                                  />
                                )}
                                {preset && t.bodyParts.includes("Other") && (
                                  <Input
                                    className="mt-2"
                                    value={t.bodyPartCustom}
                                    onChange={(e) => updateTreatment(i, { bodyPartCustom: e.target.value })}
                                    placeholder="Custom body part(s), comma separated"
                                  />
                                )}
                              </div>
                            )}

                            <div className="space-y-3 rounded-lg bg-slate-50 p-3">
                              <p className="text-xs font-semibold text-slate-600">Bundle &amp; sessions</p>
                              {pkgs.length > 0 && (
                                <ul className="space-y-1 text-xs text-slate-600">
                                  {pkgs.map((p) => {
                                    const rem = p.totalSessions - p.usedSessions;
                                    return (
                                      <li key={p.id}>
                                        <span className="font-medium">{p.machine}:</span> {rem} session{rem !== 1 ? "s" : ""} remaining
                                        <span className="text-slate-400"> · {p.packageName}</span>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                              <FormRow label="Bundle">
                                <Select
                                  value={
                                    t.applyPackageId
                                      ? `bundle:${t.applyPackageId}`
                                      : t.clientPackageId
                                        ? `pkg:${t.clientPackageId}`
                                        : "session"
                                  }
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === "session") {
                                      const existing = sessionPlans.find(
                                        (p) => p.status === "active" && (p.machine ?? "") === t.machine,
                                      );
                                      updateTreatment(i, {
                                        sessionPlan: true,
                                        sessionPlanId: existing?.id ?? "",
                                        clientPackageId: "",
                                        applyPackageId: "",
                                        sessionsNeeded: existing ? String(existing.sessionsNeeded) : t.sessionsNeeded,
                                      });
                                    } else if (v.startsWith("bundle:")) {
                                      const b = activeBundles.find((x) => x.id === v.slice(7));
                                      updateTreatment(i, {
                                        applyPackageId: b?.id ?? "",
                                        clientPackageId: "",
                                        sessionPlan: false,
                                        sessionPlanId: "",
                                        sessionsNeeded: b ? String(b.sessions) : t.sessionsNeeded,
                                        sessionsUsed: t.sessionsUsed || "1",
                                      });
                                    } else if (v.startsWith("pkg:")) {
                                      const p = pkgs.find((x) => x.id === v.slice(4));
                                      updateTreatment(i, {
                                        clientPackageId: p?.id ?? "",
                                        applyPackageId: "",
                                        sessionPlan: false,
                                        sessionPlanId: "",
                                        sessionsNeeded: p ? String(p.totalSessions) : t.sessionsNeeded,
                                      });
                                    } else {
                                      updateTreatment(i, {
                                        clientPackageId: "",
                                        applyPackageId: "",
                                        sessionPlan: false,
                                        sessionPlanId: "",
                                      });
                                    }
                                  }}
                                >
                                  <option value="session">
                                    Single paid session
                                    {treatmentPrice
                                      ? ` — ${formatMoney(treatmentPrice.price, treatmentPrice.currency)}`
                                      : ""}
                                  </option>
                                  {pkgs.length > 0 && (
                                    <optgroup label="Draw from active bundle (free)">
                                      {pkgs.map((p) => (
                                        <option key={p.id} value={`pkg:${p.id}`}>
                                          {p.packageName} — {p.totalSessions - p.usedSessions} left
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {/* Bundles are a one-time purchase startable only when the visit is
                                      first created; hide them while continuing an in-progress draft.
                                      Scoped to this treatment type. */}
                                  {!editId && bundlesForMachine(t.machine).length > 0 && (
                                    <optgroup label="Start a new bundle (prepaid)">
                                      {bundlesForMachine(t.machine).map((b) => {
                                        const net = Math.round(b.price * (1 - b.discountPercent / 100));
                                        return (
                                          <option key={b.id} value={`bundle:${b.id}`}>
                                            {b.name} — {b.sessions} sessions · {formatMoney(net, b.currency)} charged now
                                          </option>
                                        );
                                      })}
                                    </optgroup>
                                  )}
                                </Select>
                              </FormRow>
                              {selectedPkg && (
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                  <Stat label="Package" value={selectedPkg.packageName} />
                                  <Stat label="Machine" value={selectedPkg.machine ?? "—"} />
                                  <Stat label="Total" value={String(selectedPkg.totalSessions)} />
                                  <Stat label="Used" value={String(selectedPkg.usedSessions)} />
                                  <Stat label="Remaining" value={String(selectedPkg.totalSessions - selectedPkg.usedSessions)} />
                                  <Stat label="Current session #" value={String(selectedPkg.usedSessions + 1)} />
                                  <Stat
                                    label="After this visit"
                                    value={String(Math.max(0, selectedPkg.totalSessions - selectedPkg.usedSessions - sessionsUsed))}
                                  />
                                </div>
                              )}
                              {appliedBundle && (
                                <div className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700">
                                  Starting <span className="font-medium">{appliedBundle.name}</span> — full price{" "}
                                  <span className="font-medium">{formatMoney(bundleCharge, appliedBundle.currency)}</span>{" "}
                                  charged this visit. All {appliedBundle.sessions} sessions become available now; today&apos;s session is free.
                                </div>
                              )}
                              {t.sessionPlan && (
                                <div className="space-y-1 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700">
                                  {sessionPlan ? (
                                    <p>
                                      Pay-as-you-go plan · <span className="font-medium">{sessionPlan.sessionsPaid} paid</span>,{" "}
                                      {sessionPlan.sessionsUsed} used ·{" "}
                                      <span className="font-medium">{sessionCredit} session{sessionCredit === 1 ? "" : "s"} of credit</span> available.
                                    </p>
                                  ) : (
                                    <p>
                                      New pay-as-you-go plan for {t.machine || "this treatment"} — no prepaid credit yet.
                                    </p>
                                  )}
                                  {sessionsUsed > 0 &&
                                    (chargedSessions === 0 ? (
                                      <p className="font-medium text-emerald-700">
                                        Fully covered by credit — nothing to collect today.
                                      </p>
                                    ) : coveredSessions > 0 ? (
                                      <p>
                                        {coveredSessions} covered by credit · {chargedSessions} to charge at{" "}
                                        {treatmentPrice ? formatMoney(treatmentPrice.price, treatmentPrice.currency) : "per session"}.
                                      </p>
                                    ) : (
                                      <p>
                                        {chargedSessions} to charge at{" "}
                                        {treatmentPrice ? formatMoney(treatmentPrice.price, treatmentPrice.currency) : "per session"}.
                                      </p>
                                    ))}
                                </div>
                              )}
                              <div className="grid gap-3 sm:grid-cols-2">
                                <FormRow label="Number of sessions needed">
                                  <Input type="number" min={0} value={t.sessionsNeeded} onChange={(e) => updateTreatment(i, { sessionsNeeded: e.target.value })} />
                                </FormRow>
                                <FormRow label={chargedSessions > 0 ? "Sessions used today (charged)" : "Sessions used today"}>
                                  <Input type="number" min={0} value={t.sessionsUsed} onChange={(e) => updateTreatment(i, { sessionsUsed: e.target.value })} />
                                </FormRow>
                              </div>
                              {hasSource && sessionsUsed > 0 && (
                                <p className="text-xs">
                                  {coveredSessions > 0 && (
                                    <span className="text-emerald-600">
                                      {coveredSessions} free from the bundle
                                    </span>
                                  )}
                                  {coveredSessions > 0 && chargedSessions > 0 && <span className="text-slate-400"> · </span>}
                                  {chargedSessions > 0 && (
                                    <span className="text-amber-600">
                                      {chargedSessions} charged (balance used up) at {treatmentPrice ? formatMoney(treatmentPrice.price, treatmentPrice.currency) : "per session"}
                                    </span>
                                  )}
                                </p>
                              )}
                            </div>

                            <FormRow label="Notes">
                              <Textarea rows={2} value={t.notes} onChange={(e) => updateTreatment(i, { notes: e.target.value })} />
                            </FormRow>
                          </>
                        )}
                      </div>
                    );
                  })}
                  <Button variant="outline" size="sm" onClick={() => setTreatments((prev) => [...prev, { ...EMPTY_TREATMENT }])}>
                    <Plus className="h-4 w-4" /> Add treatment
                  </Button>
                </div>
              </Section>

              {/* 5. Product sale / add-on — pick a product; price comes from the catalog */}
              <Section title="Product sale / add-on items" subtitle="Products sold during the visit.">
                <div className="space-y-3">
                  {sellableProducts.length === 0 ? (
                    <p className="text-sm text-slate-400">
                      No products available. An admin can add products in Settings.
                    </p>
                  ) : (
                    <>
                      {products.length === 0 && <p className="text-sm text-slate-400">No products added.</p>}
                      {products.map((p, i) => {
                        // A line already sold on this consultation is a completed
                        // historical sale: its product and price are frozen at time
                        // of sale, so it's shown as fixed (not a live catalog dropdown
                        // that could re-point or re-price it). Only its quantity stays
                        // editable while the visit is an open draft.
                        const isSold = Boolean(p.productId && soldProductSnapshots.has(p.productId));
                        const info = p.productId ? resolveProductLine(p.productId) : undefined;
                        const qty = Number(p.quantity) || 1;
                        return (
                          <div key={i} className="rounded-lg border border-slate-200 p-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <FormRow label="Product / item">
                                {isSold ? (
                                  <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
                                    {info?.name ?? "—"}
                                    <span className="ml-2 text-xs text-slate-400">· as sold</span>
                                  </div>
                                ) : (
                                  <Select value={p.productId} onChange={(e) => updateProduct(i, { productId: e.target.value })}>
                                    <option value="">Select…</option>
                                    {sellableProducts.map((sp) => (
                                      <option key={sp.id} value={sp.id}>{sp.name}</option>
                                    ))}
                                  </Select>
                                )}
                              </FormRow>
                              <FormRow label="Quantity">
                                <Input type="number" min={1} value={p.quantity} onChange={(e) => updateProduct(i, { quantity: e.target.value })} />
                              </FormRow>
                            </div>
                            {info && (
                              <p className="mt-2 text-sm text-slate-500">
                                Price: <span className="font-medium text-slate-700">{formatMoney(info.price, info.currency)}</span>
                                {qty > 1 && (
                                  <> · Total: <span className="font-medium text-slate-700">{formatMoney(info.price * qty, info.currency)}</span></>
                                )}
                                {isSold && <span className="ml-1 text-xs text-slate-400">· frozen at time of sale</span>}
                              </p>
                            )}
                            <div className="mt-2 flex justify-end">
                              <button
                                type="button"
                                onClick={() => setProducts((prev) => prev.filter((_, idx) => idx !== i))}
                                className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-rose-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" /> Remove
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      <Button variant="outline" size="sm" onClick={() => setProducts((prev) => [...prev, { ...EMPTY_PRODUCT }])}>
                        <Plus className="h-4 w-4" /> Add product
                      </Button>
                    </>
                  )}
                </div>
              </Section>

            </CardBody>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              {canDelete && (
                <Button
                  variant="ghost"
                  className="text-rose-600 hover:bg-rose-50"
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving || deleting}
                >
                  <Trash2 className="h-4 w-4" /> Delete visit
                </Button>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => router.back()}>Cancel</Button>
              <Button variant="outline" onClick={() => save(false)} disabled={saving}>
                {saving ? "Saving…" : editId ? "Save changes (keep open)" : "Save as in-progress"}
              </Button>
              <Button onClick={() => save(true)} disabled={saving || closeBlocked} title={closeBlocked ? closeBlockedReason : undefined}>
                {saving ? "Saving…" : "Close visit"}
              </Button>
            </div>
          </div>
          {closeBlocked && (
            <p className="mt-2 text-right text-xs text-slate-400">{closeBlockedReason}</p>
          )}
        </div>

        <div className="space-y-6">
          <div className="space-y-6 lg:sticky lg:top-20">
            {(sessionPackages.length > 0 || creditPlans.length > 0) && (
              <Card>
                <CardHeader
                  title="Sessions available"
                  subtitle="Remaining balances — quick-add to this visit"
                />
                <CardBody className="space-y-2">
                  {creditPlans.map((plan) => (
                    <div
                      key={plan.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-700">
                          {plan.machine ?? "Session plan"} <span className="text-xs font-normal text-slate-400">· pay-as-you-go</span>
                        </p>
                        <p className="text-xs text-emerald-700">
                          {plan.credit} prepaid session{plan.credit === 1 ? "" : "s"} of credit available
                        </p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => addTreatmentFromSessionPlan(plan)}>
                        <Plus className="h-3.5 w-3.5" /> Use
                      </Button>
                    </div>
                  ))}
                  {sessionPackages.map((p) => {
                    const remaining = p.totalSessions - p.usedSessions;
                    return (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-700">
                            {p.machine} <span className="text-slate-400">· {p.packageName}</span>
                          </p>
                          <p className="text-xs text-slate-400">
                            {remaining} of {p.totalSessions} left
                          </p>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => addTreatmentFromPackage(p)}>
                          <Plus className="h-3.5 w-3.5" /> Use
                        </Button>
                      </div>
                    );
                  })}
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Previous visit"
                subtitle={prev ? `Visit #${prev.visitNumber} · ${formatDate(prev.date)}` : "No previous visit"}
              />
              <CardBody className="space-y-3 text-sm">
                {prev ? (
                  <>
                    <Row label="Weight" value={prev.weightKg ? `${prev.weightKg} kg` : "—"} />
                    <Row label="BMI" value={prev.bmi ? `${prev.bmi} (${bmiCategory(prev.bmi)})` : "—"} />
                    <Row label="Waist" value={prev.waistCm ? `${prev.waistCm} cm` : "—"} />
                    <Row label="Body fat" value={prev.bodyFatPercent ? `${prev.bodyFatPercent}%` : "—"} />
                    {prev.notes && (
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs font-medium text-slate-500">Notes</p>
                        <p className="mt-1 text-slate-700">{prev.notes}</p>
                      </div>
                    )}
                    {prev.recommendations && (
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs font-medium text-slate-500">Recommendation</p>
                        <p className="mt-1 text-slate-700">{prev.recommendations}</p>
                      </div>
                    )}
                    {delta && (
                      <div className="rounded-lg border border-brand-100 bg-brand-50 p-3">
                        <p className="text-xs font-medium text-brand-700">Change since last visit</p>
                        <p className={`mt-1 text-lg font-semibold ${Number(delta) <= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {Number(delta) > 0 ? "+" : ""}{delta} kg
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-slate-400">This is the client&apos;s first consultation.</p>
                )}
              </CardBody>
            </Card>

            <VisitBasketCard
              items={basketItems.map((i) => ({
                id: i.id,
                label: i.label,
                detail: i.detail,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                currency: i.currency,
                covered: i.covered,
                // Only the auto-added consultation fee carries its own remove (X);
                // treatments/products are removed from their own sections above.
                removable: i.id === "consultation-fee",
              }))}
              onRemoveItem={(id) => {
                if (id === "consultation-fee") setFeeWaived(true);
              }}
              discountOpen={discountOpen}
              discountType={discountType}
              discountValue={discountValue}
              discountReason={discountReason}
              onToggleDiscount={setDiscountOpen}
              onDiscountTypeChange={setDiscountType}
              onDiscountValueChange={setDiscountValue}
              onDiscountReasonChange={setDiscountReason}
              footer={
                feeWaived && consultationFeeAmount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setFeeWaived(false)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add consultation fee (
                    {formatMoney(consultationFeeAmount, "USD")})
                  </button>
                ) : undefined
              }
            />
          </div>
        </div>
      </div>

      <Modal
        open={manageSuppOpen}
        onClose={() => setManageSuppOpen(false)}
        title="Manage your recommended supplements"
        footer={
          <>
            <Button variant="ghost" onClick={() => setManageSuppOpen(false)}>Cancel</Button>
            <Button onClick={saveSupplements} disabled={savingSupp}>
              {savingSupp ? "Saving…" : "Save list"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            This list is personal to {myStaff?.fullName ?? "you"}. Other dietitians keep their own list — changes here won&apos;t affect them.
          </p>
          <div className="flex gap-2">
            <Input
              value={newSupp}
              onChange={(e) => setNewSupp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraftSupplement();
                }
              }}
              placeholder="Add a supplement (e.g. Creatine)"
            />
            <Button variant="outline" onClick={addDraftSupplement} disabled={!newSupp.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          {suppDraft.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-400">
              No supplements yet — add the ones you recommend.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {suppDraft.map((s) => (
                <li
                  key={s}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700"
                >
                  <span className="min-w-0 flex-1 truncate">{s}</span>
                  <button
                    type="button"
                    onClick={() => setSuppDraft((prev) => prev.filter((x) => x !== s))}
                    className="shrink-0 text-slate-400 hover:text-rose-600"
                    aria-label={`Remove ${s}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => (deleting ? undefined : setConfirmDelete(false))}
        title="Delete this consultation?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete visit"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          This permanently removes Visit #{visitNumber} for {client.firstName} {client.lastName},
          including its unsent basket. Any package sessions it used are returned to the balance.
          This can&apos;t be undone.
        </p>
        <p className="mt-2 text-xs text-slate-400">
          A visit with settled payments or recorded debt can&apos;t be deleted — settle or void
          those first.
        </p>
      </Modal>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-white px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="truncate text-xs font-medium text-slate-700">{value}</p>
    </div>
  );
}

export default function NewConsultationPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ConsultationEditor />
    </Suspense>
  );
}
