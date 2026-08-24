"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { FormRow, Input, MoneyInput, Select } from "@/components/ui/Field";
import { useApi } from "@/lib/use-api";
import { api, SuspiciousRateError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatMoney, formatDate, parseNumberInput } from "@/lib/utils";
import {
  FX_RATE_LABELS,
  describeSuspicion,
  formatFxRate,
  type FxSuspicion,
} from "@/lib/money";
import type { BotoxItem, Currency, Package, Product, Referrer, ServicePrice, StaffUser } from "@/lib/types";

/**
 * Central pricing hub (admin only). One place to manage every price on the
 * website: blood-test and treatment prices/costs, the prepaid bundles created
 * under each treatment, product prices/costs, and the USD→LBP rate that drives
 * all conversions. Each change updates the catalog everywhere it is read. `cost`
 * is owner-only — the server strips it from responses to other roles.
 */
export default function PricingPage() {
  return (
    <div>
      <PageHeader
        title="Pricing"
        subtitle="Manage every price in one place — blood tests, treatments and their bundles, and products. Costs are owner-only; changes apply everywhere they're used."
      />

      <div className="space-y-6">
        <ServicePricesCard />
        <div className="grid gap-6 lg:grid-cols-2">
          <ConsultationFeesCard />
          <CardSurchargeCard />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <ProductsCard />
          <BotoxCard />
          <ExchangeRateCard />
          <ReferrersCard />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blood tests & treatments
// ---------------------------------------------------------------------------

function ServicePricesCard() {
  const servicePrices = useApi(() => api.listServicePrices());
  // Prepaid bundles are managed per treatment type in this card.
  const bundleCatalog = useApi(() => api.listPackages());
  const [createOpen, setCreateOpen] = useState(false);
  const [bloodCreateOpen, setBloodCreateOpen] = useState(false);
  const bloodPrices = orderServicePrices(servicePrices.data ?? [], "blood_test");
  const treatmentPrices = orderServicePrices(servicePrices.data ?? [], "treatment");
  const bundles = (bundleCatalog.data ?? []).filter((p) => p.sessions > 1);

  return (
    <Card>
      <CardHeader
        title="Blood tests & treatments"
        subtitle="Prices shown in Visit services, plus the clinic's cost for each. The cost stays owner-only."
      />
      <CardBody>
        {servicePrices.loading ? (
          <p className="text-sm text-slate-400">Loading prices…</p>
        ) : servicePrices.error ? (
          <p className="text-sm text-rose-600">{servicePrices.error}</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <ServicePriceGroup
              title="Blood tests"
              prices={bloodPrices}
              deactivatable
              onChanged={() => servicePrices.refetch()}
              action={
                <Button size="sm" variant="outline" onClick={() => setBloodCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> New blood test
                </Button>
              }
            />
            <ServicePriceGroup
              title="Services / treatments"
              prices={treatmentPrices}
              deactivatable
              treatmentFeatures
              onChanged={() => servicePrices.refetch()}
              bundles={bundles}
              onBundlesChanged={() => bundleCatalog.refetch()}
              action={
                <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> New treatment type
                </Button>
              }
            />
          </div>
        )}
      </CardBody>

      <TreatmentTypeModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          servicePrices.refetch();
        }}
      />
      <BloodTestModal
        open={bloodCreateOpen}
        onClose={() => setBloodCreateOpen(false)}
        onCreated={() => {
          setBloodCreateOpen(false);
          servicePrices.refetch();
        }}
      />
    </Card>
  );
}

function ServicePriceGroup({
  title,
  prices,
  onChanged,
  deactivatable = false,
  treatmentFeatures = false,
  action,
  bundles = [],
  onBundlesChanged,
}: {
  title: string;
  prices: ServicePrice[];
  onChanged: () => void;
  // Whether rows can be deactivated/reactivated (blood tests and treatments).
  deactivatable?: boolean;
  // Treatment-only extras: body-part preset label + prepaid bundle management.
  treatmentFeatures?: boolean;
  action?: ReactNode;
  bundles?: Package[];
  onBundlesChanged?: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</p>
        {action}
      </div>
      <div className="space-y-2">
        {prices.map((price) => (
          <ServicePriceRow
            key={price.id}
            servicePrice={price}
            onChanged={onChanged}
            deactivatable={deactivatable}
            treatmentFeatures={treatmentFeatures}
            bundles={bundles.filter((b) => b.machine === price.key)}
            onBundlesChanged={onBundlesChanged}
          />
        ))}
      </div>
    </div>
  );
}

function ServicePriceRow({
  servicePrice,
  onChanged,
  deactivatable = false,
  treatmentFeatures = false,
  bundles = [],
  onBundlesChanged,
}: {
  servicePrice: ServicePrice;
  onChanged: () => void;
  deactivatable?: boolean;
  treatmentFeatures?: boolean;
  bundles?: Package[];
  onBundlesChanged?: () => void;
}) {
  const { toast } = useToast();
  const [price, setPrice] = useState(String(servicePrice.price));
  const [cost, setCost] = useState(String(servicePrice.cost ?? 0));
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);
  // The blood-test "Other" row is the fallback bucket that prices a one-off
  // custom lab test (see priceSnapshot); deactivating it would zero out that
  // pricing, so it can never be toggled off. Treatments have no such bucket —
  // there is no "Other" machine — so nothing is pinned on that side.
  const canToggleActive =
    deactivatable && !(servicePrice.kind === "blood_test" && servicePrice.key === "Other");
  // Bundles can only be started for a live treatment type, so hide their
  // management on a deactivated one.
  const showBundles = treatmentFeatures && servicePrice.active;
  const margin = parseNumberInput(price) - parseNumberInput(cost);
  const dirty =
    parseNumberInput(price) !== servicePrice.price ||
    parseNumberInput(cost) !== (servicePrice.cost ?? 0);

  async function save() {
    setSaving(true);
    try {
      await api.updateServicePrice(servicePrice.id, {
        price: parseNumberInput(price),
        cost: parseNumberInput(cost),
      });
      toast("Service price updated");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Deactivating hides an entry from new visits without touching the past visits
  // that used it (they store the name and keep displaying unchanged).
  const entryLabel = treatmentFeatures ? "Treatment type" : "Blood test";
  async function toggleActive() {
    setToggling(true);
    try {
      await api.updateServicePrice(servicePrice.id, { active: !servicePrice.active });
      toast(servicePrice.active ? `${entryLabel} deactivated` : `${entryLabel} activated`);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setToggling(false);
    }
  }

  const bodyPartLabel =
    servicePrice.bodyParts === undefined
      ? "Free-text body part"
      : servicePrice.bodyParts.length === 0
        ? "No body part"
        : servicePrice.bodyParts.join(", ");

  return (
    <div className={`rounded-lg border border-slate-200 p-3 ${deactivatable && !servicePrice.active ? "bg-slate-50 opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-700">{servicePrice.name}</p>
          {deactivatable && !servicePrice.active && <Badge tone="gray">Inactive</Badge>}
        </div>
        <p className="shrink-0 text-xs text-slate-400">
          Margin{" "}
          <span className={margin >= 0 ? "text-emerald-600" : "text-rose-600"}>
            {formatMoney(margin, servicePrice.currency)}
          </span>
        </p>
      </div>
      {treatmentFeatures && (
        <p className="mt-1 truncate text-xs text-slate-400">Body parts: {bodyPartLabel}</p>
      )}
      <div className="mt-3 flex items-end gap-3">
        <FormRow label="Price" className="flex-1"><MoneyInput value={price} onValueChange={setPrice} /></FormRow>
        <FormRow label="Cost" className="flex-1"><MoneyInput value={cost} onValueChange={setCost} /></FormRow>
        <Button size="sm" variant="outline" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {canToggleActive && (
          <Button size="sm" variant="ghost" onClick={toggleActive} disabled={toggling}>
            {servicePrice.active ? "Deactivate" : "Activate"}
          </Button>
        )}
      </div>

      {showBundles && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">Bundles (prepaid multi-session)</p>
            <Button size="sm" variant="ghost" onClick={() => setBundleOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New bundle
            </Button>
          </div>
          {bundles.length === 0 ? (
            <p className="mt-1 text-xs text-slate-400">
              No bundles yet — create one to offer it in a {servicePrice.name} treatment.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {bundles.map((b) => {
                const net = Math.round(b.price * (1 - b.discountPercent / 100));
                return (
                  <li key={b.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-slate-600">
                      <span className="font-medium text-slate-700">{b.name}</span>
                      {" · "}
                      {b.sessions} sessions · {formatMoney(net, b.currency)}
                      {b.status !== "active" && <span className="text-slate-400"> · inactive</span>}
                    </span>
                    <BundleToggle bundle={b} onChanged={onBundlesChanged} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <BundleModal
        open={bundleOpen}
        machine={servicePrice.key}
        machineName={servicePrice.name}
        currency={servicePrice.currency}
        onClose={() => setBundleOpen(false)}
        onCreated={() => {
          setBundleOpen(false);
          onBundlesChanged?.();
        }}
      />
    </div>
  );
}

function BundleToggle({ bundle, onChanged }: { bundle: Package; onChanged?: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      await api.setPackageStatus(bundle.id, bundle.status === "active" ? "inactive" : "active");
      toast(bundle.status === "active" ? "Bundle deactivated" : "Bundle activated");
      onChanged?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="ghost" onClick={toggle} disabled={busy}>
      {bundle.status === "active" ? "Deactivate" : "Activate"}
    </Button>
  );
}

const EMPTY_BUNDLE = { name: "", sessions: "", price: "", cost: "", discountPercent: "" };

// Create a prepaid multi-session bundle scoped to one treatment type. It then
// appears under "Start a new bundle" for that machine in a consultation.
function BundleModal({
  open,
  machine,
  machineName,
  currency,
  onClose,
  onCreated,
}: {
  open: boolean;
  machine: string;
  machineName: string;
  currency: Currency;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_BUNDLE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(EMPTY_BUNDLE);
  }, [open]);

  async function save() {
    if (!form.name.trim()) {
      toast("Enter a bundle name");
      return;
    }
    if (!(Number(form.sessions) > 1)) {
      toast("A bundle needs more than 1 session");
      return;
    }
    setSaving(true);
    try {
      await api.createPackage({
        name: form.name.trim(),
        description: `${form.sessions} ${machineName} sessions, prepaid.`,
        price: parseNumberInput(form.price),
        cost: parseNumberInput(form.cost),
        currency,
        sessions: Number(form.sessions),
        discountPercent: form.discountPercent ? Number(form.discountPercent) : 0,
        status: "active",
        machine,
      });
      toast("Bundle created");
      onCreated();
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
      title={`New ${machineName} bundle`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Create bundle"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow label="Name" className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={`e.g. ${machineName} 10-Pack`} />
        </FormRow>
        <FormRow label="Number of sessions"><Input type="number" min={2} value={form.sessions} onChange={(e) => setForm({ ...form, sessions: e.target.value })} placeholder="10" /></FormRow>
        <FormRow label={`Price (${currency}, charged to client)`}><MoneyInput value={form.price} onValueChange={(price) => setForm({ ...form, price })} placeholder="0" /></FormRow>
        <FormRow label={`Cost (${currency}, to the clinic)`}><MoneyInput value={form.cost} onValueChange={(cost) => setForm({ ...form, cost })} placeholder="0" /></FormRow>
        <FormRow label="Discount (%)"><Input type="number" value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} placeholder="0" /></FormRow>
      </div>
    </Modal>
  );
}

const EMPTY_TREATMENT_TYPE = {
  name: "",
  price: "",
  cost: "",
  currency: "USD",
  bodyPartMode: "list" as "list" | "free" | "none",
  bodyPartList: "",
};

// Create a new admin-defined treatment type (machine) with its body-part preset.
function TreatmentTypeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_TREATMENT_TYPE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(EMPTY_TREATMENT_TYPE);
  }, [open]);

  async function save() {
    if (!form.name.trim()) {
      toast("Enter a treatment name");
      return;
    }
    const parts = form.bodyPartList
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (form.bodyPartMode === "list" && parts.length === 0) {
      toast("Add at least one body part, or pick another body-part option");
      return;
    }
    // null = free-text entry · [] = no body-part field · [names] = fixed checklist
    const bodyParts = form.bodyPartMode === "free" ? null : form.bodyPartMode === "none" ? [] : parts;
    setSaving(true);
    try {
      await api.createServicePrice({
        name: form.name.trim(),
        price: parseNumberInput(form.price),
        cost: parseNumberInput(form.cost),
        currency: form.currency as "USD" | "LBP",
        bodyParts,
      });
      toast("Treatment type created");
      onCreated();
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
      title="New treatment type"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Create treatment type"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow label="Name" className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Cryotherapy" />
        </FormRow>
        <FormRow label="Price (charged to client)"><MoneyInput value={form.price} onValueChange={(price) => setForm({ ...form, price })} placeholder="0" /></FormRow>
        <FormRow label="Cost (to the clinic)"><MoneyInput value={form.cost} onValueChange={(cost) => setForm({ ...form, cost })} placeholder="0" /></FormRow>
        <FormRow label="Currency">
          <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD ($)</option>
            <option value="LBP">Lebanese pound (LBP)</option>
          </Select>
        </FormRow>
        <FormRow label="Body parts">
          <Select
            value={form.bodyPartMode}
            onChange={(e) => setForm({ ...form, bodyPartMode: e.target.value as typeof form.bodyPartMode })}
          >
            <option value="list">Fixed checklist</option>
            <option value="free">Free-text entry</option>
            <option value="none">No body part</option>
          </Select>
        </FormRow>
        {form.bodyPartMode === "list" && (
          <FormRow label="Preset body parts (comma separated)" className="sm:col-span-2">
            <Input
              value={form.bodyPartList}
              onChange={(e) => setForm({ ...form, bodyPartList: e.target.value })}
              placeholder="e.g. Abdomen, Thighs, Arms, Other"
            />
          </FormRow>
        )}
      </div>
    </Modal>
  );
}

const EMPTY_BLOOD_TEST = { name: "", price: "", cost: "", currency: "USD" };

// Create a new admin-defined blood test. Like a treatment type, the name is its
// stable catalog key; it then appears in every consultation's blood-collection
// checklist for all roles, and its price is snapshotted onto each visit at save.
function BloodTestModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_BLOOD_TEST);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(EMPTY_BLOOD_TEST);
  }, [open]);

  async function save() {
    if (!form.name.trim()) {
      toast("Enter a blood test name");
      return;
    }
    setSaving(true);
    try {
      await api.createServicePrice({
        kind: "blood_test",
        name: form.name.trim(),
        price: parseNumberInput(form.price),
        cost: parseNumberInput(form.cost),
        currency: form.currency as "USD" | "LBP",
      });
      toast("Blood test created");
      onCreated();
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
      title="New blood test"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Create blood test"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow label="Name" className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Vitamin D panel" />
        </FormRow>
        <FormRow label="Price (charged to client)"><MoneyInput value={form.price} onValueChange={(price) => setForm({ ...form, price })} placeholder="0" /></FormRow>
        <FormRow label="Cost (to the clinic)"><MoneyInput value={form.cost} onValueChange={(cost) => setForm({ ...form, cost })} placeholder="0" /></FormRow>
        <FormRow label="Currency" className="sm:col-span-2">
          <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD ($)</option>
            <option value="LBP">Lebanese pound (LBP)</option>
          </Select>
        </FormRow>
      </div>
    </Modal>
  );
}

// Both blood tests and treatment types are dynamic: active first, then by name,
// with the blood-test "Other" fallback bucket always last. Treatments have no
// "Other" row, so that tiebreak simply never fires for them.
function orderServicePrices(prices: ServicePrice[], kind: ServicePrice["kind"]) {
  return prices
    .filter((price) => price.kind === kind)
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        (a.key === "Other" ? 1 : 0) - (b.key === "Other" ? 1 : 0) ||
        a.name.localeCompare(b.name),
    );
}

// ---------------------------------------------------------------------------
// Consultation fees (per dietitian)
// ---------------------------------------------------------------------------

// Admin sets each dietitian's consultation fee here. The fee is tied to the real
// staff account (one row per dietitian — no free-text name), and is auto-added to
// the visit basket when that dietitian runs a consultation. USD only.
function ConsultationFeesCard() {
  const staff = useApi(() => api.listStaff());
  const dietitians = (staff.data ?? [])
    .filter((s) => s.role === "dietitian")
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        a.fullName.localeCompare(b.fullName),
    );

  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Consultation fees"
        subtitle="Set the default USD fee added when each doctor runs a consultation. It can still be removed from an individual visit."
      />
      <CardBody className="flex-1 space-y-2">
        {staff.loading ? (
          <p className="text-sm text-slate-400">Loading doctors…</p>
        ) : staff.error ? (
          <p className="text-sm text-rose-600">{staff.error}</p>
        ) : dietitians.length === 0 ? (
          <p className="text-sm text-slate-400">No doctors yet.</p>
        ) : (
          dietitians.map((d) => (
            <ConsultationFeeRow key={d.id} dietitian={d} onChanged={() => staff.refetch()} />
          ))
        )}
      </CardBody>
    </Card>
  );
}

function ConsultationFeeRow({
  dietitian,
  onChanged,
}: {
  dietitian: StaffUser;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [fee, setFee] = useState(String(dietitian.consultationFee ?? ""));
  const [saving, setSaving] = useState(false);
  const current = dietitian.consultationFee ?? 0;
  const dirty = parseNumberInput(fee) !== current;

  async function save() {
    setSaving(true);
    try {
      await api.setConsultationFee(dietitian.id, parseNumberInput(fee));
      toast("Consultation fee updated");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-700">{dietitian.fullName}</p>
          {dietitian.status !== "active" && <Badge tone="gray">Inactive</Badge>}
        </div>
        <p className="shrink-0 text-xs text-slate-400">
          {current > 0 ? (
            <>
              Current <span className="font-medium text-slate-600">{formatMoney(current, "USD")}</span>
            </>
          ) : (
            "No fee"
          )}
        </p>
      </div>
      <div className="mt-3 flex items-end gap-3">
        <FormRow label="Fee (USD)" className="min-w-0 flex-1">
          <MoneyInput value={fee} onValueChange={setFee} placeholder="0" />
        </FormRow>
        <Button size="sm" variant="outline" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function ProductsCard() {
  const { toast } = useToast();
  const products = useApi(() => api.listProducts());
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newStock, setNewStock] = useState("");
  const [adding, setAdding] = useState(false);

  async function addProduct() {
    const price = parseNumberInput(newPrice);
    const cost = parseNumberInput(newCost);
    const stock = parseNumberInput(newStock);
    if (!newName.trim()) {
      toast("Enter a product name");
      return;
    }
    setAdding(true);
    try {
      await api.createProduct({
        name: newName.trim(),
        price: price > 0 ? price : 0,
        cost: cost > 0 ? cost : 0,
        stock: stock > 0 ? Math.floor(stock) : 0,
      });
      toast("Product added");
      setNewName("");
      setNewPrice("");
      setNewCost("");
      setNewStock("");
      products.refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function removeProduct(id: string) {
    try {
      await api.deleteProduct(id);
      toast("Product removed");
      products.refetch();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Products"
        subtitle="Sellable add-ons the secretary and doctor can sell during a visit. Cost stays owner-only."
      />
      <CardBody className="space-y-4">
        <div className="space-y-2">
          {(products.data ?? []).length === 0 && (
            <p className="text-sm text-slate-400">No products yet.</p>
          )}
          {(products.data ?? []).map((p) => (
            <ProductRow key={p.id} product={p} onChanged={() => products.refetch()} onRemove={() => removeProduct(p.id)} />
          ))}
        </div>

        <div className="border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-medium text-slate-500">Add a product</p>
          <div className="grid gap-3 sm:grid-cols-4">
            <FormRow label="Name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Detox tea" /></FormRow>
            <FormRow label="Price"><MoneyInput value={newPrice} onValueChange={setNewPrice} placeholder="0" /></FormRow>
            <FormRow label="Cost"><MoneyInput value={newCost} onValueChange={setNewCost} placeholder="0" /></FormRow>
            <FormRow label="Initial stock"><Input type="number" min={0} step={1} value={newStock} onChange={(e) => setNewStock(e.target.value)} placeholder="0" /></FormRow>
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={addProduct} disabled={adding}>{adding ? "Adding…" : "Add product"}</Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** Stock badge tone: out of stock (red) beats low stock (amber) beats fine (neutral). */
function stockTone(stock: number, threshold: number): "red" | "amber" | "gray" {
  if (stock <= 0) return "red";
  if (stock <= threshold) return "amber";
  return "gray";
}

function ProductRow({
  product,
  onChanged,
  onRemove,
}: {
  product: Product;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const { toast } = useToast();
  const [price, setPrice] = useState(String(product.price));
  const [cost, setCost] = useState(String(product.cost ?? 0));
  const [threshold, setThreshold] = useState(String(product.lowStockThreshold));
  const [saving, setSaving] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const margin = parseNumberInput(price) - parseNumberInput(cost);
  const dirty =
    parseNumberInput(price) !== product.price ||
    parseNumberInput(cost) !== (product.cost ?? 0) ||
    parseNumberInput(threshold) !== product.lowStockThreshold;

  async function save() {
    setSaving(true);
    try {
      await api.updateProduct(product.id, {
        price: parseNumberInput(price),
        cost: parseNumberInput(cost),
        lowStockThreshold: Math.max(0, Math.floor(parseNumberInput(threshold))),
      });
      toast("Product updated");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const tone = stockTone(product.stock, product.lowStockThreshold);

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-slate-700">{product.name}</p>
            <Badge tone={tone}>
              {product.stock <= 0 ? `Out of stock (${product.stock})` : `${product.stock} in stock`}
            </Badge>
          </div>
          <p className="text-xs text-slate-400">
            Margin{" "}
            <span className={margin >= 0 ? "text-emerald-600" : "text-rose-600"}>
              {formatMoney(margin, product.currency)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAdjustOpen(true)}>Adjust stock</Button>
          <button
            type="button"
            onClick={onRemove}
            className="text-slate-400 hover:text-rose-600"
            aria-label="Remove product"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-end gap-3">
        <FormRow label="Price" className="flex-1"><MoneyInput value={price} onValueChange={setPrice} /></FormRow>
        <FormRow label="Cost" className="flex-1"><MoneyInput value={cost} onValueChange={setCost} /></FormRow>
        <FormRow label="Low stock at" className="flex-1">
          <Input type="number" min={0} step={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </FormRow>
        <Button size="sm" variant="outline" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <StockAdjustModal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        product={product}
        onAdjusted={() => {
          setAdjustOpen(false);
          onChanged();
        }}
      />
    </div>
  );
}

/**
 * Every post-creation stock change goes through this — never a raw overwrite —
 * so AuditLog stays the complete history (see adjustProductStockTx). "Restock"
 * covers new inventory arriving; "Correction" covers fixing a miscount/damage
 * and accepts a negative amount, unlike restock.
 */
function StockAdjustModal({
  open,
  onClose,
  product,
  onAdjusted,
}: {
  open: boolean;
  onClose: () => void;
  product: Product;
  onAdjusted: () => void;
}) {
  const { toast } = useToast();
  const [type, setType] = useState<"restock" | "correction">("restock");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setType("restock");
      setAmount("");
      setReason("");
    }
  }, [open]);

  async function save() {
    const raw = Math.trunc(Number(amount));
    if (!Number.isFinite(raw) || raw === 0) {
      toast("Enter a non-zero amount");
      return;
    }
    if (type === "restock" && raw < 0) {
      toast("Restock amount must be positive — use Correction to reduce stock");
      return;
    }
    setSaving(true);
    try {
      await api.adjustProductStock(product.id, { delta: raw, type, reason: reason.trim() || undefined });
      toast(type === "restock" ? "Stock added" : "Stock corrected");
      onAdjusted();
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
      title={`Adjust stock — ${product.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">Current stock: {product.stock}</p>
        <FormRow label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as "restock" | "correction")}>
            <option value="restock">Restock (new inventory arrived)</option>
            <option value="correction">Correction (fix a miscount/damage)</option>
          </Select>
        </FormRow>
        <FormRow label={type === "restock" ? "Amount received" : "Amount (+/-)"}>
          <Input
            type="number"
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={type === "restock" ? "e.g. 20" : "e.g. -2"}
          />
        </FormRow>
        <FormRow label="Reason (optional)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Shipment from supplier" />
        </FormRow>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Botox
// ---------------------------------------------------------------------------

/**
 * The Botox catalog: name + a default/base price the doctor sees when picking
 * an item in a consultation. That price is only a starting point — the doctor
 * freely sets what a given visit actually charges (no bound, either way), so
 * this card is the "default," not a hard price the patient must pay. Which
 * doctors may even see the Botox section is set on the Staff page, not here.
 */
function BotoxCard() {
  const { toast } = useToast();
  const items = useApi(() => api.listBotoxItems());
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newCost, setNewCost] = useState("");
  const [adding, setAdding] = useState(false);

  async function addItem() {
    const price = parseNumberInput(newPrice);
    const cost = parseNumberInput(newCost);
    if (!newName.trim()) {
      toast("Enter a Botox item name");
      return;
    }
    setAdding(true);
    try {
      await api.createBotoxItem({
        name: newName.trim(),
        price: price > 0 ? price : 0,
        cost: cost > 0 ? cost : 0,
      });
      toast("Botox item added");
      setNewName("");
      setNewPrice("");
      setNewCost("");
      items.refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function removeItem(id: string) {
    try {
      await api.deleteBotoxItem(id);
      toast("Botox item removed");
      items.refetch();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Botox"
        subtitle="Default price shown to the doctor when picking an item. USD only. Cost stays owner-only."
      />
      <CardBody className="space-y-4">
        <div className="space-y-2">
          {(items.data ?? []).length === 0 && (
            <p className="text-sm text-slate-400">No Botox items yet.</p>
          )}
          {(items.data ?? []).map((b) => (
            <BotoxRow key={b.id} item={b} onChanged={() => items.refetch()} onRemove={() => removeItem(b.id)} />
          ))}
        </div>

        <div className="border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-medium text-slate-500">Add a Botox item</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormRow label="Name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Forehead" /></FormRow>
            <FormRow label="Default price (USD)"><MoneyInput value={newPrice} onValueChange={setNewPrice} placeholder="0" /></FormRow>
            <FormRow label="Cost"><MoneyInput value={newCost} onValueChange={setNewCost} placeholder="0" /></FormRow>
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={addItem} disabled={adding}>{adding ? "Adding…" : "Add item"}</Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function BotoxRow({
  item,
  onChanged,
  onRemove,
}: {
  item: BotoxItem;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const { toast } = useToast();
  const [price, setPrice] = useState(String(item.price));
  const [cost, setCost] = useState(String(item.cost ?? 0));
  const [active, setActive] = useState(item.active);
  const [saving, setSaving] = useState(false);
  const dirty =
    parseNumberInput(price) !== item.price ||
    parseNumberInput(cost) !== (item.cost ?? 0) ||
    active !== item.active;

  async function save() {
    setSaving(true);
    try {
      await api.updateBotoxItem(item.id, {
        price: parseNumberInput(price),
        cost: parseNumberInput(cost),
        active,
      });
      toast("Botox item updated");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-slate-700">{item.name}</p>
            {!item.active && <Badge tone="gray">Inactive</Badge>}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-slate-400 hover:text-rose-600"
          aria-label="Remove Botox item"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <FormRow label="Default price" className="flex-1"><MoneyInput value={price} onValueChange={setPrice} /></FormRow>
        <FormRow label="Cost" className="flex-1"><MoneyInput value={cost} onValueChange={setCost} /></FormRow>
        <FormRow label="Status" className="flex-1">
          <Select value={active ? "active" : "inactive"} onChange={(e) => setActive(e.target.value === "active")}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </FormRow>
        <Button size="sm" variant="outline" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exchange rate (drives every LBP conversion across the app)
// ---------------------------------------------------------------------------

function ExchangeRateCard() {
  const { toast } = useToast();
  const settings = useApi(() => api.getSettings());
  const history = useApi(() => api.listFxRateChanges());
  const [rate, setRate] = useState("");
  const [eurRate, setEurRate] = useState("");
  const [saving, setSaving] = useState(false);
  // Set when the server refused a change as suspicious. Holds the jumps it
  // detected AND the exact values that were submitted — confirming re-sends those
  // same values, so editing the field afterwards invalidates the confirmation
  // (the server checks this too; this just keeps the UI honest).
  const [pending, setPending] = useState<
    { suspicions: FxSuspicion[]; usdToLbp: number; usdToEur: number } | null
  >(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setRate(String(settings.data.usdToLbp));
      setEurRate(String(settings.data.usdToEur));
    }
  }, [settings.data]);

  async function submit(confirm: boolean) {
    const usdToLbp = parseNumberInput(rate);
    const usdToEur = parseNumberInput(eurRate);
    if (!(usdToLbp > 0) || !(usdToEur > 0)) {
      toast("Enter valid rates greater than 0");
      return;
    }
    setSaving(true);
    try {
      await api.updateSettings({
        usdToLbp,
        usdToEur,
        // Only ever sent as part of an explicit confirm, and always carrying the
        // values actually being saved — never a bare "ignore the warning" flag.
        ...(confirm ? { confirmSuspicious: { usdToLbp, usdToEur } } : {}),
      });
      setPending(null);
      toast(confirm ? "Exchange rates updated (change confirmed)" : "Exchange rates updated");
      settings.refetch();
      history.refetch();
    } catch (e) {
      if (e instanceof SuspiciousRateError) {
        // Nothing was saved. Show exactly what would change and make the admin
        // say yes to it deliberately.
        setPending({ suspicions: e.suspicions, usdToLbp, usdToEur });
      } else {
        toast((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  // Editing a field after being warned retires the warning — the next submit is a
  // fresh, unconfirmed one.
  function edit(setter: (v: string) => void) {
    return (v: string) => {
      setPending(null);
      setter(v);
    };
  }

  const rows = history.data ?? [];

  return (
    <>
      <Card>
        <CardHeader
          title="Exchange rates"
          subtitle="Used to convert every LBP and EUR payment to the USD the clinic accounts in."
          action={
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              Change history
            </Button>
          }
        />
        <CardBody className="grid gap-4">
          <FormRow label="1 USD = ? LBP">
            <MoneyInput value={rate} onValueChange={edit(setRate)} placeholder="89500" />
          </FormRow>
          <FormRow label="1 USD = ? EUR">
            <MoneyInput value={eurRate} onValueChange={edit(setEurRate)} placeholder="0.92" />
          </FormRow>
          <p className="text-xs text-slate-400">
            Changing a rate affects payments taken from now on. Payments already recorded keep the
            rate frozen on them and are never re-valued.
          </p>
          {pending && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-900">This looks like a typo</p>
              <ul className="mt-1 space-y-1 text-xs text-amber-800">
                {pending.suspicions.map((sx) => (
                  <li key={sx.rateKey}>{describeSuspicion(sx)}</li>
                ))}
              </ul>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => submit(true)} disabled={saving}>
                  {saving ? "Saving…" : "Yes, save this rate"}
                </Button>
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={() => submit(false)} disabled={saving || settings.loading || Boolean(pending)}>
              {saving ? "Saving…" : "Save rates"}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Exchange rate history"
        footer={
          <Button variant="outline" onClick={() => setHistoryOpen(false)}>
            Close
          </Button>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          Every change to a rate, newest first. This record is append-only — it cannot be edited or
          deleted from anywhere in the app.
        </p>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">No rate changes recorded yet.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => (
              <li key={r.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-slate-800">{FX_RATE_LABELS[r.rateKey]}</span>
                  <span className="text-slate-700">
                    {r.oldValue === undefined ? (
                      <span className="text-slate-400">(unset)</span>
                    ) : (
                      formatFxRate(r.currency, r.oldValue)
                    )}
                    <span className="mx-1 text-slate-300">→</span>
                    <span className="font-semibold">{formatFxRate(r.currency, r.newValue)}</span>
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                  <span>{r.changedByName}</span>
                  <span>·</span>
                  <span>{formatDate(r.changedAt)}</span>
                  {r.suspiciousOverride && (
                    <Badge tone="amber">Unusual change — confirmed by admin</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Referrers & card surcharge
// ---------------------------------------------------------------------------

// Admin-set fee added to a card payment, e.g. 10 = 10%. Applied server-side
// whenever the method is "card" — a normal payment's full amount, or just the
// card portion of a split settlement. 0 (the default) disables it. Changing it
// only affects payments recorded from now on; past receipts keep whatever was
// applied when they were made.
function CardSurchargeCard() {
  const { toast } = useToast();
  const settings = useApi(() => api.getSettings());
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data) setRate(String(settings.data.cardSurchargePercent));
  }, [settings.data]);

  async function save() {
    const cardSurchargePercent = Number(rate);
    if (!Number.isFinite(cardSurchargePercent) || cardSurchargePercent < 0 || cardSurchargePercent > 100) {
      toast("Enter a percentage between 0 and 100");
      return;
    }
    setSaving(true);
    try {
      await api.updateSettings({ cardSurchargePercent });
      toast("Card surcharge updated");
      settings.refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Card surcharge"
        subtitle="Fee added to a payment made by card. Set to 0 to disable it."
      />
      <CardBody className="flex-1">
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-slate-700">Card payments</p>
            <p className="text-xs text-slate-400">
              {Number(rate) > 0 ? `${rate}% fee` : "Disabled"}
            </p>
          </div>
          <div className="mt-3 flex items-end gap-3">
            <FormRow label="Surcharge (%)" className="min-w-0 flex-1">
              <Input
                type="number"
                min={0}
                max={100}
                step="0.1"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0"
              />
            </FormRow>
            <Button size="sm" onClick={save} disabled={saving || settings.loading}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// Admin-editable list of who refers patients (e.g. a partner doctor, or "None"
// for self-referred). Drives the referrer dropdown at registration and check-in.
// The chosen name is snapshotted onto the client, so renaming/removing here never
// rewrites past client records.
function ReferrersCard() {
  const { toast } = useToast();
  const referrers = useApi(() => api.listReferrers());
  const [newName, setNewName] = useState("");
  const [newFee, setNewFee] = useState("");
  const [adding, setAdding] = useState(false);

  async function addReferrer() {
    if (!newName.trim()) {
      toast("Enter a referrer name");
      return;
    }
    setAdding(true);
    try {
      await api.createReferrer({ name: newName.trim(), fee: Number(newFee) || 0 });
      toast("Referrer added");
      setNewName("");
      setNewFee("");
      referrers.refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Referrers"
        subtitle="Who refers patients to the clinic — offered at registration and check-in, alongside a built-in “None” option for patients who came organically (no referrer, no fee). The referral fee is the commission paid per patient they send. Renaming, removing or re-pricing one never changes past client records (each patient's fee is frozen at registration)."
      />
      <CardBody className="space-y-4">
        <div className="space-y-2">
          {referrers.loading ? (
            <p className="text-sm text-slate-400">Loading referrers…</p>
          ) : referrers.error ? (
            <p className="text-sm text-rose-600">{referrers.error}</p>
          ) : (referrers.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-400">No referrers yet.</p>
          ) : (
            (referrers.data ?? []).map((r) => (
              <ReferrerRow key={r.id} referrer={r} onChanged={() => referrers.refetch()} />
            ))
          )}
        </div>

        <div className="border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-medium text-slate-500">Add a referrer</p>
          <div className="flex items-end gap-3">
            <FormRow label="Name" className="flex-1">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Dr. Karam" />
            </FormRow>
            <FormRow label="Fee / referral (USD)" className="w-40">
              <Input
                type="number"
                min={0}
                step="0.01"
                value={newFee}
                onChange={(e) => setNewFee(e.target.value)}
                placeholder="0"
              />
            </FormRow>
            <Button size="sm" onClick={addReferrer} disabled={adding}>
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function ReferrerRow({ referrer, onChanged }: { referrer: Referrer; onChanged: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(referrer.name);
  const [fee, setFee] = useState(String(referrer.fee));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameDirty = name.trim() !== referrer.name && name.trim() !== "";
  const feeDirty = (Number(fee) || 0) !== referrer.fee;
  const dirty = nameDirty || feeDirty;

  // Saves whichever of name/fee changed. Editing the fee only changes the LIVE
  // rate for future referrals — commissions already frozen onto past patients are
  // untouched (that snapshot lives on the client, not here).
  async function save() {
    setSaving(true);
    try {
      await api.updateReferrer(referrer.id, {
        ...(nameDirty ? { name: name.trim() } : {}),
        ...(feeDirty ? { fee: Number(fee) || 0 } : {}),
      });
      toast("Referrer updated");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Deactivating hides a referrer from the dropdown without touching the clients
  // who already recorded it (their snapshotted name keeps displaying unchanged).
  async function toggleActive() {
    setBusy(true);
    try {
      await api.updateReferrer(referrer.id, { active: !referrer.active });
      toast(referrer.active ? "Referrer deactivated" : "Referrer activated");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteReferrer(referrer.id);
      toast("Referrer removed");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex items-end gap-3 rounded-lg border border-slate-200 p-3 ${referrer.active ? "" : "bg-slate-50 opacity-70"}`}>
      <FormRow label="Name" className="flex-1">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </FormRow>
      <FormRow label="Fee / referral (USD)" className="w-40">
        <Input type="number" min={0} step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
      </FormRow>
      {!referrer.active && <Badge tone="gray">Inactive</Badge>}
      <Button size="sm" variant="outline" onClick={save} disabled={saving || !dirty}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={toggleActive} disabled={busy}>
        {referrer.active ? "Deactivate" : "Activate"}
      </Button>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="pb-2 text-slate-400 hover:text-rose-600 disabled:opacity-50"
        aria-label="Remove referrer"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
