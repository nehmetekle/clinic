"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CreditCard,
  PhoneCall,
  Receipt,
  UserPlus,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { VISIT_TYPE_LABELS } from "@/lib/types";
import { formatMoney, formatTime } from "@/lib/utils";

export function SecretaryDashboard() {
  const router = useRouter();
  const { data, loading, error } = useApi(() => api.getDashboard());

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const today = data.todaysAppointments;

  return (
    <div>
      <PageHeader
        title="Front desk"
        subtitle="Here's what's happening at the front desk today."
        action={
          <>
            <Button onClick={() => router.push("/appointments/phone-booking")}>
              <PhoneCall className="h-4 w-4" /> Phone Booking
            </Button>
            <Button variant="outline" onClick={() => router.push("/payments")}>
              <CreditCard className="h-4 w-4" /> Record Payment
            </Button>
            <Button variant="outline" onClick={() => router.push("/expenses")}>
              <Receipt className="h-4 w-4" /> Add Expense
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Today's appointments" value={today.length} icon={CalendarDays} tone="blue" />
        <StatCard label="New clients today" value={data.counts.newToday} icon={UserPlus} tone="green" />
        <StatCard label="Payments today" value={formatMoney(data.finance.paymentsToday)} icon={CreditCard} tone="brand" />
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Today's appointments"
            action={
              <Link href="/queue" className="text-xs font-medium text-brand-700 hover:underline">
                Open queue →
              </Link>
            }
          />
          <Table>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Client</TH>
                <TH>Visit</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {today.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{formatTime(a.time)}</TD>
                  <TD>{a.clientName}</TD>
                  <TD className="text-slate-500">{VISIT_TYPE_LABELS[a.visitType] ?? a.visitType}</TD>
                  <TD>
                    <Link
                      href={`/clients/${a.clientId}`}
                      className="text-xs font-medium text-brand-700 hover:underline"
                    >
                      Open
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Recent payments"
            action={
              <Link href="/payments" className="text-xs font-medium text-brand-700 hover:underline">
                View all →
              </Link>
            }
          />
          <Table>
            <THead>
              <TR>
                <TH>Receipt</TH>
                <TH>Client</TH>
                <TH>Motif</TH>
                <TH>Amount</TH>
              </TR>
            </THead>
            <TBody>
              {data.recentPayments.map((p) => (
                <TR key={p.id}>
                  <TD className="font-mono text-xs">{p.receiptNumber}</TD>
                  <TD>{p.clientName ?? "—"}</TD>
                  <TD className="text-slate-500">{p.motif}</TD>
                  <TD className="font-medium">{formatMoney(p.amountPaid, p.currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
