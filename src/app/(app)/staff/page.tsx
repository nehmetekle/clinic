"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { FormRow, Input, PhoneInput, Select } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { ROLE_LABELS } from "@/lib/nav";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Role, StaffUser } from "@/lib/types";

const EMPTY = { fullName: "", email: "", phone: "", role: "secretary" as Role, status: "active", password: "" };

export default function StaffPage() {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi(() => api.listStaff());
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [resetTarget, setResetTarget] = useState<StaffUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [editTarget, setEditTarget] = useState<StaffUser | null>(null);
  const [editForm, setEditForm] = useState({ fullName: "", email: "", phone: "", role: "secretary" as Role, status: "active" });
  const [editing, setEditing] = useState(false);

  function openEdit(s: StaffUser) {
    setEditForm({
      fullName: s.fullName,
      email: s.email,
      phone: s.phone ?? "",
      role: s.role,
      status: s.status,
    });
    setEditTarget(s);
  }

  async function saveEdit() {
    if (!editTarget) return;
    setEditing(true);
    try {
      await api.updateStaff(editTarget.id, {
        fullName: editForm.fullName,
        email: editForm.email,
        phone: editForm.phone || undefined,
        role: editForm.role,
        status: editForm.status as "active" | "inactive",
      });
      toast("Staff details updated");
      setEditTarget(null);
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setEditing(false);
    }
  }

  async function resetPasswordFor() {
    if (!resetTarget) return;
    setResetting(true);
    try {
      await api.resetStaffPassword(resetTarget.id, resetPassword);
      toast(`Password reset for ${resetTarget.fullName}`);
      setResetTarget(null);
      setResetPassword("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  async function toggleStatus(id: string, current: string) {
    const next = current === "active" ? "inactive" : "active";
    try {
      await api.setStaffStatus(id, next);
      toast(`Account ${next === "active" ? "enabled" : "disabled"}`);
      refetch();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.createStaff(form);
      toast("Staff account created");
      setForm(EMPTY);
      setOpen(false);
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Staff management"
        subtitle="Manage user accounts, roles and access."
        action={
          <Button onClick={() => setOpen(true)}>
            <UserPlus className="h-4 w-4" /> Add staff
          </Button>
        }
      />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Phone</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Created</TH>
                <TH>Last login</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {(data ?? []).map((s) => (
                <TR key={s.id}>
                  <TD className="font-medium">{s.fullName}</TD>
                  <TD className="text-slate-500">{s.email}</TD>
                  <TD className="text-slate-500">{s.phone ?? "—"}</TD>
                  <TD className="text-slate-600">{ROLE_LABELS[s.role]}</TD>
                  <TD><Badge tone={s.status === "active" ? "green" : "gray"}>{s.status}</Badge></TD>
                  <TD className="text-slate-500">{formatDate(s.createdAt)}</TD>
                  <TD className="text-slate-500">{s.lastLoginAt ? formatDateTime(s.lastLoginAt) : "—"}</TD>
                  <TD>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(s)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => setResetTarget(s)}>Reset password</Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleStatus(s.id, s.status)}>
                        {s.status === "active" ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add staff member"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Create account"}</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow label="Full name" className="sm:col-span-2">
            <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="Jane Doe" />
          </FormRow>
          <FormRow label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@nutriclinic.com" />
          </FormRow>
          <FormRow label="Password" className="sm:col-span-2">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </FormRow>
          <FormRow label="Phone">
            <PhoneInput value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
          </FormRow>
          <FormRow label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="secretary">Secretary / Receptionist</option>
              <option value="dietitian">Doctor</option>
              <option value="admin">Admin / Owner</option>
            </Select>
          </FormRow>
          <FormRow label="Status">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </FormRow>
        </div>
      </Modal>

      <Modal
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title={`Reset password for ${resetTarget?.fullName ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetTarget(null)}>Cancel</Button>
            <Button onClick={resetPasswordFor} disabled={resetting || resetPassword.length < 8}>
              {resetting ? "Resetting…" : "Reset password"}
            </Button>
          </>
        }
      >
        <FormRow label="New password">
          <Input
            type="password"
            value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
        </FormRow>
        <p className="mt-2 text-xs text-slate-500">
          This immediately signs them out everywhere; they&apos;ll need this new password next time.
        </p>
      </Modal>

      <Modal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title={`Edit ${editTarget?.fullName ?? "staff member"}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={editing || !editForm.fullName.trim() || !editForm.email.trim()}>
              {editing ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow label="Full name" className="sm:col-span-2">
            <Input value={editForm.fullName} onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })} />
          </FormRow>
          <FormRow label="Email" className="sm:col-span-2">
            <Input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
          </FormRow>
          <FormRow label="Phone">
            <PhoneInput value={editForm.phone} onChange={(phone) => setEditForm({ ...editForm, phone })} />
          </FormRow>
          <FormRow label="Role">
            <Select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value as Role })}>
              <option value="secretary">Secretary / Receptionist</option>
              <option value="dietitian">Doctor</option>
              <option value="admin">Admin / Owner</option>
            </Select>
          </FormRow>
          <FormRow label="Status" className="sm:col-span-2">
            <Select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </FormRow>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          To change the password, use “Reset password” instead.
        </p>
      </Modal>
    </div>
  );
}
