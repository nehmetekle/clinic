"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  DollarSign,
  HandCoins,
  PiggyBank,
  TrendingDown,
  Users,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import {
  ProfitTrendChart,
  TopMachinesChart,
} from "@/components/charts/Charts";
import { Input } from "@/components/ui/Field";
import { RevenueKindBreakdown } from "@/components/RevenueKindBreakdown";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { todayIso } from "@/lib/config";
import { PERIOD_PRESETS, periodRange, rangeLabel, type PeriodPreset } from "@/lib/period";
import { cn, formatMoney } from "@/lib/utils";

export function AdminDashboard() {
  const router = useRouter();
  const [period, setPeriod] = useState<PeriodPreset>("This month");
  const today = todayIso();
  const [customFrom, setCustomFrom] = useState(`${today.slice(0, 7)}-01`);
  const [customTo, setCustomTo] = useState(today);
  const [openReferrer, setOpenReferrer] = useState<string | null>(null);
  const [showRevenueKinds, setShowRevenueKinds] = useState(false);
  const range =
    period === "Custom"
      ? { from: customFrom, to: customTo }
      : periodRange(period, today);
  // Refetch when the window changes; keep the current view mounted meanwhile so
  // the selector doesn't flash a full-page spinner on every toggle.
  const { data, loading, error } = useApi(() => api.getDashboard(range), [range.from, range.to]);
  const products = useApi(() => api.listProducts());

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const { finance, counts } = data;
  const lowStockProducts = (products.data ?? [])
    .filter((p) => p.active && p.stock <= p.lowStockThreshold)
    .sort((a, b) => a.stock - b.stock);

  return (
    <div>
      <PageHeader
        title="Business overview"
        subtitle="Clinic performance at a glance."
        action={
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {PERIOD_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  period === p
                    ? "bg-brand-600 text-white"
                    : "text-slate-500 hover:text-slate-700",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        }
      />

      {period === "Custom" && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-500">
            From
            <Input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1" />
          </label>
          <label className="text-xs font-medium text-slate-500">
            To
            <Input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="mt-1" />
          </label>
        </div>
      )}

      <p className="mb-3 text-sm text-slate-500">
        Revenue, costs and profit earned in{" "}
        <span className="font-medium text-slate-700">{rangeLabel(range.from, range.to)}</span>. Outstanding debts are current.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Revenue" value={formatMoney(finance.revenue)} icon={DollarSign} tone="green" hint="What was earned →" onClick={() => setShowRevenueKinds(true)} />
        <StatCard label="Net profit" value={formatMoney(finance.netProfit)} icon={PiggyBank} tone={finance.netProfit >= 0 ? "brand" : "rose"} />
        <StatCard label="Net cash" value={formatMoney(finance.netCash)} icon={PiggyBank} tone={finance.netCash >= 0 ? "brand" : "rose"} />
        <StatCard label="Owed by clients" value={formatMoney(finance.unpaidBalance)} icon={TrendingDown} tone="amber" hint="View who owes →" onClick={() => router.push("/clients?filter=owes")} />
        <StatCard label="Owed to referrers" value={formatMoney(finance.referralOutstanding)} icon={HandCoins} tone="amber" hint="Open referral ledger →" onClick={() => router.push("/referrals")} />
      </div>

      <RevenueKindBreakdown
        open={showRevenueKinds}
        onClose={() => setShowRevenueKinds(false)}
        periodLabel={rangeLabel(range.from, range.to)}
        rows={finance.revenueByKind}
        revenue={finance.revenue}
        cogs={finance.cogs}
      />


      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total clients" value={counts.totalClients} icon={Users} tone="blue" />
        <StatCard label="Active clients" value={counts.activeClients} tone="brand" />
        <StatCard label="Consultations" value={counts.consultations} icon={Activity} tone="slate" />
        <StatCard label="Machine visits" value={counts.machineVisits} icon={Zap} tone="brand" />
        <StatCard label="New this month" value={counts.newThisMonth} tone="green" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Profit trend"
            subtitle="Last 6 months, earned not collected — costs are COGS + operating expenses + referrer commissions"
          />
          <CardBody>
            <ProfitTrendChart data={data.profitSeries} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Most-used machines" subtitle="Top 5 by sessions delivered this period" />
          <CardBody>
            <TopMachinesChart data={data.topMachines} />
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Staff activity" subtitle="Consultations & front-desk activity" />
          <Table>
            <THead>
              <TR>
                <TH>Staff</TH>
                <TH>Role</TH>
                <TH>Consultations</TH>
                <TH>Machine visits</TH>
              </TR>
            </THead>
            <TBody>
              {data.staffActivity.map((s) => (
                <TR key={s.name}>
                  <TD className="font-medium">{s.name}</TD>
                  <TD className="capitalize text-slate-500">{s.role}</TD>
                  <TD>{s.consults}</TD>
                  <TD>{s.machineVisits}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader
            title="Referrers"
            subtitle={`Patients registered ${rangeLabel(range.from, range.to)}, grouped by who referred them`}
          />
          <Table>
            <THead>
              <TR>
                <TH>Referrer</TH>
                <TH className="text-right">Patients</TH>
              </TR>
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

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Needs attention"
            subtitle="Clients with outstanding debts"
            action={<AlertTriangle className="h-4 w-4 text-amber-500" />}
          />
          <CardBody>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Outstanding debts ({data.unpaidClients.length})
            </p>
            <ul className="space-y-2">
              {data.unpaidClients.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/clients/${r.id}`}
                    className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
                  >
                    <span className="text-sm text-slate-700">{r.name}</span>
                    <span className="text-sm font-medium text-rose-600">{formatMoney(r.balance)}</span>
                  </Link>
                </li>
              ))}
              {data.unpaidClients.length === 0 && (
                <li className="text-sm text-slate-400">No outstanding debts.</li>
              )}
            </ul>

            <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Low stock ({lowStockProducts.length})
            </p>
            <ul className="space-y-2">
              {lowStockProducts.map((p) => (
                <li key={p.id}>
                  <Link
                    href="/pricing"
                    className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
                  >
                    <span className="text-sm text-slate-700">{p.name}</span>
                    <span className={cn("text-sm font-medium", p.stock <= 0 ? "text-rose-600" : "text-amber-600")}>
                      {p.stock <= 0 ? `Out of stock (${p.stock})` : `${p.stock} left`}
                    </span>
                  </Link>
                </li>
              ))}
              {lowStockProducts.length === 0 && (
                <li className="text-sm text-slate-400">No products low on stock.</li>
              )}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
