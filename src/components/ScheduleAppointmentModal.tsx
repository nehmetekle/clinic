"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FieldGrid, FormRow, Select, WeekdayDateInput } from "@/components/ui/Field";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { todayIso } from "@/lib/config";
import { defaultSlot, formatDate, formatTime, timeSlots } from "@/lib/utils";
import { VISIT_TYPE_LABELS, VISIT_TYPE_VALUES } from "@/lib/types";
import type { Appointment, StaffUser, VisitType } from "@/lib/types";

const SLOTS = timeSlots();

/**
 * Single source of truth for the fields every appointment-booking flow needs:
 * who (doctor), what (visit type), and when (date/time). Shared by the
 * client-profile Schedule modal and the phone-booking page so a future field
 * or validation change only has to happen here.
 */
export interface AppointmentBooking {
  dietitianId: string;
  date: string;
  time: string;
  visitType: VisitType;
}

export function defaultAppointmentBooking(dietitianId: string = ""): AppointmentBooking {
  const slot = defaultSlot(todayIso());
  return { dietitianId, date: slot.date, time: slot.time, visitType: "follow_up" };
}

export function AppointmentScheduleFields({
  value,
  onChange,
  dietitians,
  minDate = todayIso(),
}: {
  value: AppointmentBooking;
  onChange: (value: AppointmentBooking) => void;
  dietitians: StaffUser[];
  minDate?: string;
}) {
  return (
    <FieldGrid>
      <FormRow label="Date">
        <WeekdayDateInput min={minDate} value={value.date} onChange={(v) => onChange({ ...value, date: v })} />
      </FormRow>
      <FormRow label="Time slot">
        <Select value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })}>
          {SLOTS.map((t) => <option key={t} value={t}>{formatTime(t)}</option>)}
        </Select>
      </FormRow>
      <FormRow label="Doctor">
        <Select value={value.dietitianId} onChange={(e) => onChange({ ...value, dietitianId: e.target.value })}>
          <option value="">Select doctor…</option>
          {dietitians.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
        </Select>
      </FormRow>
      <FormRow label="Visit type">
        <Select value={value.visitType} onChange={(e) => onChange({ ...value, visitType: e.target.value as VisitType })}>
          {VISIT_TYPE_VALUES.map((v) => <option key={v} value={v}>{VISIT_TYPE_LABELS[v]}</option>)}
        </Select>
      </FormRow>
    </FieldGrid>
  );
}

/**
 * Centralized "schedule an appointment for a known client" modal — used
 * anywhere on the site that books a visit for a client already on screen
 * (client profile, etc). Phone-booking has its own page shell (it also has to
 * search for/create the client first) but renders the same
 * `AppointmentScheduleFields` and posts through the same `api.createAppointment`.
 */
export function ScheduleAppointmentModal({
  open,
  onClose,
  clientId,
  clientName,
  defaultDietitianId,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  defaultDietitianId?: string | null;
  onScheduled?: () => void;
}) {
  const { toast } = useToast();
  const staff = useApi(() => api.listStaff());
  const dietitians = (staff.data ?? []).filter((s) => s.role === "dietitian");

  const [booking, setBooking] = useState<AppointmentBooking>(() => defaultAppointmentBooking(defaultDietitianId ?? ""));
  const [saving, setSaving] = useState(false);

  // Re-default every time the modal opens (and once the client's assigned
  // doctor has loaded) rather than on every render, so a mid-edit selection
  // isn't clobbered while the modal is open.
  useEffect(() => {
    if (open) setBooking(defaultAppointmentBooking(defaultDietitianId ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultDietitianId]);

  async function submit() {
    setSaving(true);
    try {
      await api.createAppointment({
        clientId,
        dietitianId: booking.dietitianId || null,
        date: booking.date,
        time: booking.time,
        visitType: booking.visitType,
      });
      toast(`Appointment scheduled for ${clientName}`);
      onClose();
      onScheduled?.();
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
      title={`Schedule appointment — ${clientName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Schedule"}</Button>
        </>
      }
    >
      <AppointmentScheduleFields value={booking} onChange={setBooking} dietitians={dietitians} />
    </Modal>
  );
}

/**
 * Which appointments can still be moved. A booking is only reschedulable while
 * it is untouched (`scheduled`) and hasn't already passed: once the patient is
 * checked in, seen, cancelled or marked no-show, that slot is history and the
 * right action is a fresh booking. Mirrors the server guard in
 * `rescheduleAppointment` so the button never offers something the API refuses.
 */
export function isReschedulable(a: Pick<Appointment, "status" | "date">): boolean {
  return a.status === "scheduled" && a.date >= todayIso();
}

/**
 * Centralized "move this booking to another slot" modal — used everywhere an
 * upcoming appointment is listed (client profile, appointments day view, queue
 * board). Pre-fills with the appointment's current slot and edits the row in
 * place, so the appointment keeps its identity and history shows one row per
 * booking rather than a cancelled/rebooked pair.
 */
export function RescheduleAppointmentModal({
  appointment,
  onClose,
  onRescheduled,
}: {
  /** The appointment being moved; `null` keeps the modal closed. */
  appointment: Appointment | null;
  onClose: () => void;
  onRescheduled?: () => void;
}) {
  const { toast } = useToast();
  const staff = useApi(() => api.listStaff());
  const dietitians = (staff.data ?? []).filter((s) => s.role === "dietitian");

  const [booking, setBooking] = useState<AppointmentBooking>(() => defaultAppointmentBooking());
  const [saving, setSaving] = useState(false);

  // Seed the form from the appointment each time a different one is picked, so
  // the staff member starts from the current slot and only changes what moves.
  useEffect(() => {
    if (!appointment) return;
    setBooking({
      dietitianId: appointment.dietitianId ?? "",
      date: appointment.date,
      time: appointment.time,
      visitType: appointment.visitType,
    });
  }, [appointment]);

  async function submit() {
    if (!appointment) return;
    setSaving(true);
    try {
      await api.rescheduleAppointment(appointment.id, {
        dietitianId: booking.dietitianId || null,
        date: booking.date,
        time: booking.time,
        visitType: booking.visitType,
      });
      toast(`Appointment moved to ${formatDate(booking.date)} at ${formatTime(booking.time)}`);
      onClose();
      onRescheduled?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={appointment != null}
      onClose={onClose}
      title={appointment ? `Reschedule appointment — ${appointment.clientName}` : "Reschedule appointment"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep current slot</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Reschedule"}</Button>
        </>
      }
    >
      {appointment && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Currently booked for{" "}
            <span className="font-medium text-slate-800">{formatDate(appointment.date)}</span> at{" "}
            <span className="font-medium text-slate-800">{formatTime(appointment.time)}</span>. Pick the
            new slot below — the appointment moves, it isn&rsquo;t cancelled and rebooked.
          </p>
          <AppointmentScheduleFields value={booking} onChange={setBooking} dietitians={dietitians} />
        </div>
      )}
    </Modal>
  );
}
