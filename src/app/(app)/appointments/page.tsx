"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, CalendarSearch } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AppointmentBadge, Badge } from "@/components/ui/Badge";
import { FormRow, Input } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { todayIso } from "@/lib/config";
import { VISIT_TYPE_LABELS } from "@/lib/types";
import { bmiCategory, formatDate, formatTime } from "@/lib/utils";

export default function AppointmentsPage() {
  const router = useRouter();
  const { user } = useSession();
  const isClinical = user?.role === "dietitian" || user?.role === "admin";
  // Dietitians can't book appointments — booking is a secretary/admin action.
  const canBook = user?.role !== "dietitian";
  const { data, loading, error } = useApi(() => api.listAppointments());
  const consultations = useApi(() => api.listConsultations());

  const [selectedDate, setSelectedDate] = useState(todayIso());

  const appointments = data ?? [];
  const allVisits = consultations.data ?? [];

  const dayAppts = appointments
    .filter((a) => a.date === selectedDate)
    .sort((a, b) => a.time.localeCompare(b.time));
  const dayVisits = allVisits.filter((c) => c.date === selectedDate);

  return (
    <div>
      <PageHeader
        title="Appointments & history"
        subtitle="Pick a date to see the patients we had that day."
        action={
          canBook ? (
            <Button onClick={() => router.push("/appointments/phone-booking")}>
              <CalendarPlus className="h-4 w-4" /> Schedule appointment
            </Button>
          ) : null
        }
      />

      {/* Date picker */}
      <Card className="mb-6">
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <FormRow label="View date" className="w-44">
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </FormRow>
            <Button
              variant={selectedDate === todayIso() ? "primary" : "outline"}
              onClick={() => setSelectedDate(todayIso())}
            >
              Today
            </Button>
          </div>
        </CardBody>
      </Card>

      {loading || consultations.loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={`Patients on ${formatDate(selectedDate)}`}
              subtitle={`${dayAppts.length} appointment${dayAppts.length !== 1 ? "s" : ""} scheduled`}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Patient</TH>
                  <TH>Dietitian</TH>
                  <TH>Visit type</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {dayAppts.map((a) => (
                  <TR key={a.id} onClick={() => router.push(`/clients/${a.clientId}`)}>
                    <TD className="font-medium">{formatTime(a.time)}</TD>
                    <TD>{a.clientName}</TD>
                    <TD className="text-slate-500">{a.dietitianName}</TD>
                    <TD className="text-slate-500">{VISIT_TYPE_LABELS[a.visitType] ?? a.visitType}</TD>
                    <TD><AppointmentBadge status={a.status} /></TD>
                    <TD>
                      {/* The whole row opens the patient profile; the real status
                          lives in the badge column, so this is just that affordance. */}
                      <span className="text-xs font-medium text-brand-700">View</span>
                    </TD>
                  </TR>
                ))}
                {dayAppts.length === 0 && (
                  <TR>
                    <TD colSpan={6} className="py-8 text-center text-slate-400">
                      No appointments scheduled on this date.
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </Card>

          {isClinical && (
          <Card>
            <CardHeader
              title={`Consultations recorded on ${formatDate(selectedDate)}`}
              subtitle={`${dayVisits.length} visit${dayVisits.length !== 1 ? "s" : ""} recorded`}
              action={<CalendarSearch className="h-4 w-4 text-slate-400" />}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Patient</TH>
                  <TH>Visit</TH>
                  <TH>Weight</TH>
                  <TH>BMI</TH>
                  <TH>Dietitian</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {dayVisits.map((c) => (
                  <TR key={c.id} onClick={() => router.push(`/clients/${c.clientId}`)}>
                    <TD className="font-medium">{c.clientName}</TD>
                    <TD>#{c.visitNumber}</TD>
                    <TD>{c.weightKg ? `${c.weightKg} kg` : "—"}</TD>
                    <TD className="text-slate-500">
                      {c.bmi ? `${c.bmi} · ${bmiCategory(c.bmi)}` : "—"}
                    </TD>
                    <TD className="text-slate-500">{c.dietitianName}</TD>
                    <TD>
                      {c.status === "open" ? (
                        <Badge tone="amber">In progress</Badge>
                      ) : (
                        <Badge tone="green">Done</Badge>
                      )}
                    </TD>
                    <TD>
                      {/* An open visit reopens directly in the editor; a closed one
                          is read-only, so the row-click to the profile is enough. */}
                      {c.status === "open" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(
                              `/consultations/new?client=${c.clientId}&consultation=${c.id}`,
                            );
                          }}
                        >
                          Continue
                        </Button>
                      ) : (
                        <span className="text-xs font-medium text-brand-700">View</span>
                      )}
                    </TD>
                  </TR>
                ))}
                {dayVisits.length === 0 && (
                  <TR>
                    <TD colSpan={7} className="py-8 text-center text-slate-400">
                      No consultations recorded on this date.
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </Card>
          )}
        </div>
      )}
    </div>
  );
}
