"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormRow, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import type { Referrer } from "@/lib/types";

export default function SettingsPage() {
  const { toast } = useToast();

  return (
    <div>
      <PageHeader title="Settings" subtitle="Clinic-wide configuration." />

      <div className="grid gap-6 lg:grid-cols-2">
        <ReferrersCard />
        <TwoFactorCard />

        <Card>
          <CardHeader title="Data" />
          <CardBody className="space-y-3">
            <p className="text-sm text-slate-500">Export or back up clinic data.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => toast("Full data export arrives in Version 4")}>Export all data (CSV)</Button>
              <Button variant="outline" onClick={() => toast("Automated backups arrive in Version 4")}>Download backup</Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

// Two-factor auth for the CURRENT admin's own account (docs/01-product-spec.md
// §3.1). Setup is a 3-step dance: request a secret+QR, scan it in an
// authenticator app, then prove it worked by entering a live code — only then
// does the server turn totpEnabled on and hand back one-time backup codes.
function TwoFactorCard() {
  const { user, refresh } = useSession();
  const { toast } = useToast();
  const [setupOpen, setSetupOpen] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  async function startSetup() {
    setBusy(true);
    try {
      const res = await api.setupTwoFactor();
      setSecret(res.secret);
      setQrCodeDataUrl(res.qrCodeDataUrl);
      setBackupCodes(null);
      setConfirmCode("");
      setSetupOpen(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup() {
    setBusy(true);
    try {
      const res = await api.confirmTwoFactor(confirmCode);
      setBackupCodes(res.backupCodes);
      await refresh();
      toast("Two-factor authentication enabled");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await api.disableTwoFactor(disablePassword);
      await refresh();
      toast("Two-factor authentication disabled");
      setDisableOpen(false);
      setDisablePassword("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        subtitle="Require a code from an authenticator app (in addition to your password) when signing in."
      />
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge tone={user.totpEnabled ? "green" : "gray"}>
            {user.totpEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        {user.totpEnabled ? (
          <Button variant="outline" onClick={() => setDisableOpen(true)}>Disable 2FA</Button>
        ) : (
          <Button onClick={startSetup} disabled={busy}>{busy ? "Starting…" : "Set up 2FA"}</Button>
        )}
      </CardBody>

      <Modal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title="Set up two-factor authentication"
        footer={
          backupCodes ? (
            <Button onClick={() => setSetupOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setSetupOpen(false)}>Cancel</Button>
              <Button onClick={confirmSetup} disabled={busy || confirmCode.length !== 6}>
                {busy ? "Verifying…" : "Verify & enable"}
              </Button>
            </>
          )
        }
      >
        {backupCodes ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Save these backup codes somewhere safe — each works once, if you ever lose access to
              your authenticator app. They won&apos;t be shown again.
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 font-mono text-sm">
              {backupCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password…),
              then enter the 6-digit code it shows.
            </p>
            {qrCodeDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrCodeDataUrl} alt="2FA QR code" className="mx-auto h-44 w-44" />
            )}
            {secret && (
              <p className="text-center font-mono text-xs text-slate-400">
                Can&apos;t scan? Enter manually: {secret}
              </p>
            )}
            <FormRow label="6-digit code">
              <Input
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                autoFocus
              />
            </FormRow>
          </div>
        )}
      </Modal>

      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Disable two-factor authentication"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisableOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={disable} disabled={busy || !disablePassword}>
              {busy ? "Disabling…" : "Disable"}
            </Button>
          </>
        }
      >
        <FormRow label="Confirm your password">
          <Input
            type="password"
            value={disablePassword}
            onChange={(e) => setDisablePassword(e.target.value)}
            autoComplete="current-password"
          />
        </FormRow>
      </Modal>
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
  const [adding, setAdding] = useState(false);

  async function addReferrer() {
    if (!newName.trim()) {
      toast("Enter a referrer name");
      return;
    }
    setAdding(true);
    try {
      await api.createReferrer({ name: newName.trim() });
      toast("Referrer added");
      setNewName("");
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
        subtitle="Who refers patients to the clinic — offered at registration and check-in. Renaming or removing one never changes past client records."
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
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== referrer.name && name.trim() !== "";

  async function rename() {
    setSaving(true);
    try {
      await api.updateReferrer(referrer.id, { name: name.trim() });
      toast("Referrer renamed");
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
      {!referrer.active && <Badge tone="gray">Inactive</Badge>}
      <Button size="sm" variant="outline" onClick={rename} disabled={saving || !dirty}>
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
