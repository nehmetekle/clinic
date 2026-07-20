"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Download } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { Input, Select } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { IncomeExpenseChart, RevenueBarChart } from "@/components/charts/Charts";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { todayIso } from "@/lib/config";
import { PERIOD_PRESETS, periodRange, rangeLabel, type PeriodPreset } from "@/lib/period";
import { useToast } from "@/lib/toast";
import { cn, downloadCsv, formatMoney } from "@/lib/utils";

export default function ReportsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [period, setPeriod] = useState<PeriodPreset>("This month");
  const today = todayIso();
  const [customFrom, setCustomFrom] = useState(`${today.slice(0, 7)}-01`);
  const [customTo, setCustomTo] = useState(today);
  const [openReferrer, setOpenReferrer] = useState<string | null>(null);
  const range =
    period === "Custom"
      ? { from: customFrom, to: customTo }
      : periodRange(period, today);
  const { data, loading, error } = useApi(() => api.getDashboard(range), [range.from, range.to]);
  const clients = useApi(() => api.listClients());

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const phoneById = new Map((clients.data ?? []).map((c) => [c.id, c.phone]));

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      "outstanding-debts.csv",
      data.unpaidClients.map((r) => ({
        Client: r.name,
        Phone: phoneById.get(r.id) ?? "",
        Debt: r.balance,
      })),
    );
    toast("Exported outstanding debts to CSV");
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Business performance and financial reports."
        action={
          <>
            <Button variant="outline" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>
            <Button variant="outline" onClick={() => toast("PDF export arrives in Version 4")}><Download className="h-4 w-4" /> Export PDF</Button>
          </>
        }
      />

      <Card className="mb-6">
        <CardBody className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-500">
            Period
            <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodPreset)} className="mt-1">
              {PERIOD_PRESETS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </label>
          {period === "Custom" && (
            <>
              <label className="text-xs font-medium text-slate-500">
                From
                <Input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1" />
              </label>
              <label className="text-xs font-medium text-slate-500">
                To
                <Input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="mt-1" />
              </label>
            </>
          )}
        </CardBody>
      </Card>

      <p className="mb-3 text-sm text-slate-500">
        Income, expenses and net profit for{" "}
        <span className="font-medium text-slate-700">{rangeLabel(range.from, range.to)}</span>. Outstanding debts are current.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total income" value={formatMoney(data.finance.totalIncome)} tone="green" />
        <StatCard label="Total expenses" value={formatMoney(data.finance.totalExpenses)} tone="rose" />
        <StatCard label="Net profit" value={formatMoney(data.finance.netProfit)} tone={data.finance.netProfit >= 0 ? "brand" : "rose"} />
        <StatCard label="Gross margin" value={formatMoney(data.finance.grossMargin)} tone={data.finance.grossMargin >= 0 ? "brand" : "rose"} />
        <StatCard label="Outstanding debts" value={formatMoney(data.finance.unpaidBalance)} tone="amber" hint="View who owes →" onClick={() => router.push("/clients?filter=owes")} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Income vs expenses" subtitle="Last 6 months" />
          <CardBody><IncomeExpenseChart data={data.incomeExpenseSeries} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Most profitable bundles" />
          <CardBody><RevenueBarChart data={data.packageRevenue} /></CardBody>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader title="Outstanding client debts" subtitle={`${data.unpaidClients.length} clients owe money`} />
          <Table>
            <THead>
              <TR><TH>Client</TH><TH>Phone</TH><TH>Outstanding debt</TH></TR>
            </THead>
            <TBody>
              {data.unpaidClients.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.name}</TD>
                  <TD className="text-slate-500">{phoneById.get(r.id) ?? "—"}</TD>
                  <TD className="font-medium text-rose-600">{formatMoney(r.balance)}</TD>
                </TR>
              ))}
              {data.unpaidClients.length === 0 && (
                <TR><TD colSpan={3} className="py-6 text-center text-slate-400">No outstanding debts.</TD></TR>
              )}
            </TBody>
          </Table>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Referrers"
            subtitle={`Patients registered ${rangeLabel(range.from, range.to)}, grouped by who referred them`}
          />
          <Table>
            <THead>
              <TR><TH>Referrer</TH><TH className="text-right">Patients</TH></TR>
            </THead>
            <TBody>
              {data.referrerReport.map((r) => {
                const open = openReferrer === r.name;
                return (
                  <Fragment key={r.name}>
                    <TR onClick={() => setOpenReferrer(open ? null : r.name)}>
                      <TD className="font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          <ChevronRight className={cn("h-4 w-4 text-slate-400 transition-transform", open && "rotate-90")} />
                          {r.name}
                        </span>
                      </TD>
                      <TD className="text-right">{r.count}</TD>
                    </TR>
                    {open && (
                      <TR>
                        <TD colSpan={2} className="bg-slate-50/60 !whitespace-normal">
                          <ul className="flex flex-col gap-1 py-1 pl-6">
                            {r.patients.map((p) => (
                              <li key={p.id}>
                                <Link href={`/clients/${p.id}`} className="text-brand-600 hover:underline">
                                  {p.name}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </TD>
                      </TR>
                    )}
                  </Fragment>
                );
              })}
              {data.referrerReport.length === 0 && (
                <TR><TD colSpan={2} className="py-6 text-center text-slate-400">No patients registered in this period.</TD></TR>
              )}
            </TBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
