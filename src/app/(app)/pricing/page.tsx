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
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatMoney, parseNumberInput } from "@/lib/utils";
import type { Currency, Package, Product, ServicePrice, StaffUser } from "@/lib/types";

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
        <ConsultationFeesCard />
        <div className="grid gap-6 lg:grid-cols-2">
          <ProductsCard />
          <ExchangeRateCard />
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
  // The "Other" row is the fallback bucket that prices every custom test/treatment
  // (see priceSnapshot); deactivating it would zero out custom pricing, so it can
  // never be toggled off.
  const canToggleActive = deactivatable && servicePrice.key !== "Other";
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

// Both blood tests and treatment types are dynamic: active first, then by name
// with the "Other" fallback bucket always last.
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
    <Card>
      <CardHeader
        title="Consultation fees"
        subtitle="Per-dietitian fee auto-added to the visit basket when that dietitian runs the consultation. Charged in USD; set 0 for no fee. The dietitian can remove it from an individual visit."
      />
      <CardBody className="space-y-2">
        {staff.loading ? (
          <p className="text-sm text-slate-400">Loading dietitians…</p>
        ) : staff.error ? (
          <p className="text-sm text-rose-600">{staff.error}</p>
        ) : dietitians.length === 0 ? (
          <p className="text-sm text-slate-400">No dietitians yet.</p>
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
        <FormRow label="Fee (USD)" className="flex-1">
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
  const [adding, setAdding] = useState(false);

  async function addProduct() {
    const price = parseNumberInput(newPrice);
    const cost = parseNumberInput(newCost);
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
      });
      toast("Product added");
      setNewName("");
      setNewPrice("");
      setNewCost("");
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
        subtitle="Sellable add-ons the secretary and dietitian can sell during a visit. Cost stays owner-only."
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
          <div className="grid gap-3 sm:grid-cols-3">
            <FormRow label="Name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Detox tea" /></FormRow>
            <FormRow label="Price"><MoneyInput value={newPrice} onValueChange={setNewPrice} placeholder="0" /></FormRow>
            <FormRow label="Cost"><MoneyInput value={newCost} onValueChange={setNewCost} placeholder="0" /></FormRow>
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={addProduct} disabled={adding}>{adding ? "Adding…" : "Add product"}</Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
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
  const [saving, setSaving] = useState(false);
  const margin = parseNumberInput(price) - parseNumberInput(cost);
  const dirty =
    parseNumberInput(price) !== product.price ||
    parseNumberInput(cost) !== (product.cost ?? 0);

  async function save() {
    setSaving(true);
    try {
      await api.updateProduct(product.id, {
        price: parseNumberInput(price),
        cost: parseNumberInput(cost),
      });
      toast("Product updated");
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
          <p className="truncate text-sm font-medium text-slate-700">{product.name}</p>
          <p className="text-xs text-slate-400">
            Margin{" "}
            <span className={margin >= 0 ? "text-emerald-600" : "text-rose-600"}>
              {formatMoney(margin, product.currency)}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-slate-400 hover:text-rose-600"
          aria-label="Remove product"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex items-end gap-3">
        <FormRow label="Price" className="flex-1"><MoneyInput value={price} onValueChange={setPrice} /></FormRow>
        <FormRow label="Cost" className="flex-1"><MoneyInput value={cost} onValueChange={setCost} /></FormRow>
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
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data) setRate(String(settings.data.usdToLbp));
  }, [settings.data]);

  async function saveRate() {
    const value = parseNumberInput(rate);
    if (!(value > 0)) {
      toast("Enter a valid rate greater than 0");
      return;
    }
    setSaving(true);
    try {
      await api.updateSettings({ usdToLbp: value });
      toast("Exchange rate updated");
      settings.refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Exchange rate" subtitle="USD → LBP. Used to convert every total across the app." />
      <CardBody className="grid gap-4">
        <FormRow label="1 USD = ? LBP">
          <MoneyInput value={rate} onValueChange={setRate} placeholder="89500" />
        </FormRow>
        <div className="flex justify-end">
          <Button onClick={saveRate} disabled={saving || settings.loading}>
            {saving ? "Saving…" : "Save rate"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
