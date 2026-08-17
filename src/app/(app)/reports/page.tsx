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
import { ProfitTrendChart, TopMachinesChart } from "@/components/charts/Charts";
import { ReferrerCostBreakdown } from "@/components/ReferrerCostBreakdown";
import { PaymentMethodBreakdown } from "@/components/PaymentMethodBreakdown";
import { RevenueKindBreakdown } from "@/components/RevenueKindBreakdown";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { todayIso } from "@/lib/config";
import { PERIOD_PRESETS, periodRange, rangeLabel, type PeriodPreset } from "@/lib/period";
import { useToast } from "@/lib/toast";
import { cn, downloadCsvSections, formatMoney } from "@/lib/utils";

export default function ReportsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [period, setPeriod] = useState<PeriodPreset>("This month");
  const today = todayIso();
  const [customFrom, setCustomFrom] = useState(`${today.slice(0, 7)}-01`);
  const [customTo, setCustomTo] = useState(today);
  const [openReferrer, setOpenReferrer] = useState<string | null>(null);
  const [showReferrerCost, setShowReferrerCost] = useState(false);
  const [showIncomeMethods, setShowIncomeMethods] = useState(false);
  const [showRevenueKinds, setShowRevenueKinds] = useState(false);
  // Scopes the EARNED figures to one dietitian. "" = the whole clinic.
  const [dietitianId, setDietitianId] = useState("");
  // A custom range needs BOTH bounds. Half a range is not an open-ended range:
  // sending a blank bound used to be read as "no bound" and quietly widened the
  // whole report to all time while the header still named the period. Until both
  // dates are filled the last valid window stays on screen, unchanged.
  const customIncomplete = period === "Custom" && (!customFrom || !customTo);
  const customInverted = period === "Custom" && !!customFrom && !!customTo && customFrom > customTo;
  const range =
    period === "Custom"
      ? { from: customFrom, to: customTo }
      : periodRange(period, today);
  const rangeValid = !customIncomplete && !customInverted;
  const { data, loading, error } = useApi(
    () => api.getDashboard({ ...range, dietitianId: dietitianId || undefined }),
    [range.from, range.to, rangeValid, dietitianId],
    { enabled: rangeValid },
  );
  const clients = useApi(() => api.listClients());
  const staff = useApi(() => api.listStaff());

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  // F-16: figures already on screen belong to the PREVIOUS period until the new
  // ones arrive. Rather than show last month's numbers under this month's
  // heading as though they were settled, the whole report is dimmed and made
  // non-interactive while it reloads — visibly provisional, not quietly wrong.
  const stale = loading;

  const phoneById = new Map((clients.data ?? []).map((c) => [c.id, c.phone]));
  const dietitians = (staff.data ?? []).filter((u) => u.role === "dietitian");
  const dietitianName = dietitians.find((d) => d.id === dietitianId)?.fullName;
  // A dietitian's REVENUE is meaningful; a dietitian's NET PROFIT is not. Rent,
  // salaries and referrer commissions belong to the clinic, and splitting them
  // across dietitians would require an allocation nobody has agreed. So the
  // filter scopes the gross-profit block and the whole-clinic block is hidden
  // rather than shown scoped-in-part, which would silently charge one person
  // with the clinic's overheads.
  const scoped = dietitianId !== "";

  // Exports the whole report, not just one of its tables, with every money column
  // named in the unit it is actually in (all USD — obligations are USD-denominated
  // however they were tendered) and fixed to the cent, so a raw float can't arrive
  // in a spreadsheet as 41.660000000000004.
  function exportCsv() {
    if (!data) return;
    const usd = (n: number) => n.toFixed(2);
    const f = data.finance;
    const period = rangeLabel(range.from, range.to);

    // Scoped exports carry ONLY what the filter legitimately scopes. The
    // clinic-wide sections are dropped rather than exported unscoped beside
    // scoped ones, which would read as one dietitian's costs.
    const scopeLabel = scoped ? ` — ${dietitianName}` : "";
    const clinicWide = <T,>(rows: T[]) => (scoped ? [] : rows);

    const wrote = downloadCsvSections(
      `nutriclinic-report-${range.from}-to-${range.to}${scoped ? `-${dietitianName?.replace(/\s+/g, "-")}` : ""}.csv`,
      [
      {
        title: `Profitability (earned) — ${period}${scopeLabel}`,
        rows: [
          { Figure: "Revenue", "Amount (USD)": usd(f.revenue) },
          { Figure: "Cost of goods sold", "Amount (USD)": usd(f.cogs) },
          { Figure: "Gross profit", "Amount (USD)": usd(f.grossProfit) },
          {
            Figure: "Gross margin (%)",
            "Amount (USD)": f.grossMarginPercent === null ? "" : f.grossMarginPercent.toFixed(1),
          },
          { Figure: "Discounts given", "Amount (USD)": usd(f.discounts) },
          // Clinic-wide, so omitted entirely from a per-dietitian export.
          ...clinicWide([
            { Figure: "Operating expenses", "Amount (USD)": usd(f.operatingExpenses) },
            { Figure: "Referrer cost", "Amount (USD)": usd(f.referrerCost) },
            { Figure: "Net profit", "Amount (USD)": usd(f.netProfit) },
          ]),
        ],
      },
      {
        title: `Revenue by category${scopeLabel}`,
        rows: f.revenueByKind.map((r) => ({
          Category: r.kind,
          "Revenue (USD)": usd(r.revenue),
          "Cost (USD)": usd(r.cogs),
          "Gross profit (USD)": usd(r.revenue - r.cogs),
        })),
      },
      {
        // Balances, deliberately labelled as such: they are current, not for the
        // period above, and a reader of the file has no other way to know that.
        title: "Cash and balances (collected in period; balances are current)",
        rows: clinicWide([
          { Figure: `Collected — ${period}`, "Amount (USD)": usd(f.totalIncome) },
          { Figure: "Owed by clients (current)", "Amount (USD)": usd(f.unpaidBalance) },
          { Figure: "Owed by Jessy (current)", "Amount (USD)": usd(f.jessyOutstanding) },
          { Figure: "Owed to referrers (current)", "Amount (USD)": usd(f.referralOutstanding) },
        ]),
      },
      {
        title: "Outstanding client debts (current)",
        rows: clinicWide(data.unpaidClients).map((r) => ({
          Client: r.name,
          Phone: phoneById.get(r.id) ?? "",
          "Outstanding debt (USD)": usd(r.balance),
        })),
      },
      {
        title: `Bundle profitability — ${period}${scopeLabel}`,
        rows: data.packageRevenue.map((b) => ({
          Bundle: b.name,
          Sold: b.sales,
          "Revenue (USD)": usd(b.revenue),
          "Cost (USD)": usd(b.cogs),
          "Gross profit (USD)": usd(b.grossProfit),
          "Gross margin (%)": b.grossMarginPercent === null ? "" : b.grossMarginPercent.toFixed(1),
        })),
      },
      {
        title: `Machine utilization — ${period}`,
        rows: clinicWide(data.machineUtilization).map((m) => ({
          Machine: m.machine,
          "Sessions delivered": m.sessions,
          "Sessions at machine visits": m.machineVisitSessions,
          "Sessions in consultations": m.consultationSessions,
          "Machine visits": m.machineVisits,
        })),
      },
      {
        title: `Referrers — patients registered ${period}`,
        rows: clinicWide(data.referrerReport).map((r) => ({ Referrer: r.name, Patients: r.count })),
      },
      ],
    );

    // Only claim an export happened if a file was actually written.
    toast(wrote ? `Exported the report for ${period}` : "There is nothing to export for this period.");
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Business performance and financial reports."
        action={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={stale || !rangeValid}><Download className="h-4 w-4" /> Export CSV</Button>
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
          <label className="text-xs font-medium text-slate-500">
            Dietitian
            <Select
              value={dietitianId}
              onChange={(e) => setDietitianId(e.target.value)}
              className="mt-1"
            >
              <option value="">Whole clinic</option>
              {dietitians.map((d) => (
                <option key={d.id} value={d.id}>{d.fullName}</option>
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
          {customIncomplete && (
            <p className="w-full text-sm font-medium text-amber-700">
              Pick both a start and an end date. The figures below are still for the
              last complete range.
            </p>
          )}
          {customInverted && (
            <p className="w-full text-sm font-medium text-amber-700">
              The start date is after the end date. The figures below are still for the
              last complete range.
            </p>
          )}
        </CardBody>
      </Card>

      {/* Dimmed and inert while a new period loads: what is on screen still
          belongs to the previous range, and it must not read as final. */}
      <div
        className={cn(
          "transition-opacity",
          (stale || !rangeValid) && "pointer-events-none opacity-40",
        )}
        aria-busy={stale}
      >
      <p className="mb-3 text-sm text-slate-500">
        Revenue, costs and profit earned in{" "}
        <span className="font-medium text-slate-700">{rangeLabel(range.from, range.to)}</span>
        {scoped && (
          <>
            {" "}from <span className="font-medium text-slate-700">{dietitianName}</span>&apos;s visits
          </>
        )}
        . A sale is counted when the transaction is finalized — a prepaid package is
        recognized in full when it is bought, and using those sessions later adds
        nothing.
      </p>

      {/* THE PROFIT HIERARCHY, read top to bottom:
              Revenue − COGS = Gross profit → − Operating expenses − Referrer cost
              = Net profit. Each line is the one above it, less the cost named. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Revenue" value={formatMoney(data.finance.revenue)} tone="green" hint="What was earned →" onClick={() => setShowRevenueKinds(true)} />
        <StatCard label="Cost of goods sold" value={formatMoney(data.finance.cogs)} tone="rose" />
        <StatCard
          label="Gross profit"
          value={formatMoney(data.finance.grossProfit)}
          tone={data.finance.grossProfit >= 0 ? "brand" : "rose"}
        />
        <StatCard
          label="Gross margin"
          value={data.finance.grossMarginPercent === null ? "—" : `${data.finance.grossMarginPercent}%`}
          tone={(data.finance.grossMarginPercent ?? 0) >= 0 ? "brand" : "rose"}
        />
      </div>

      {/* Clinic-wide costs and net profit. Hidden while the report is scoped to one
          dietitian: these costs are the clinic's, not any one person's, and
          subtracting them from a single dietitian's revenue would be a made-up
          number rather than a smaller true one. */}
      {scoped ? (
        <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          Operating expenses, referrer cost, net profit and the cash balances are
          clinic-wide and are not shown for a single dietitian — they can&apos;t be
          attributed to one person. Switch back to{" "}
          <button onClick={() => setDietitianId("")} className="font-medium text-brand-600 hover:underline">
            the whole clinic
          </button>{" "}
          to see them.
        </p>
      ) : (
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Operating expenses" value={formatMoney(data.finance.operatingExpenses)} tone="rose" />
        <StatCard label="Referrer cost" value={formatMoney(data.finance.referrerCost)} tone="rose" hint="View breakdown →" onClick={() => setShowReferrerCost(true)} />
        <StatCard label="Net profit" value={formatMoney(data.finance.netProfit)} tone={data.finance.netProfit >= 0 ? "brand" : "rose"} />
        <StatCard label="Discounts given" value={formatMoney(data.finance.discounts)} tone="amber" />
      </div>
      )}

      {!scoped && (
      <>
      <p className="mt-6 mb-3 text-sm text-slate-500">
        <span className="font-medium text-slate-700">Cash and balances.</span> What was
        actually collected, and what is still owed — kept separate from the profit
        figures above. A sale on credit is revenue when it is made and cash when it is
        collected; the balances are current, not for the selected period.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Collected" value={formatMoney(data.finance.totalIncome)} tone="green" hint="By method →" onClick={() => setShowIncomeMethods(true)} />
        <StatCard label="Owed by clients" value={formatMoney(data.finance.unpaidBalance)} tone="amber" hint="View who owes →" onClick={() => router.push("/clients?filter=owes")} />
        {/* Money Jessy has not transferred yet. NOT revenue and NOT patient debt. */}
        <StatCard label="Owed by Jessy" value={formatMoney(data.finance.jessyOutstanding)} tone="amber" hint="Open Jessy ledger →" onClick={() => router.push("/jessy")} />
        {/* Commissions already recognized as an expense; this is the unpaid cash. */}
        <StatCard label="Owed to referrers" value={formatMoney(data.finance.referralOutstanding)} tone="amber" hint="Open referral ledger →" onClick={() => router.push("/referrals")} />
      </div>
      </>
      )}

      <ReferrerCostBreakdown
        open={showReferrerCost}
        onClose={() => setShowReferrerCost(false)}
        periodLabel={rangeLabel(range.from, range.to)}
        report={data.referrerCostReport}
      />

      <RevenueKindBreakdown
        open={showRevenueKinds}
        onClose={() => setShowRevenueKinds(false)}
        periodLabel={rangeLabel(range.from, range.to)}
        rows={data.finance.revenueByKind}
        revenue={data.finance.revenue}
        cogs={data.finance.cogs}
      />

      <PaymentMethodBreakdown
        open={showIncomeMethods}
        onClose={() => setShowIncomeMethods(false)}
        title="Collected by method"
        periodLabel={rangeLabel(range.from, range.to)}
        byMethod={data.finance.incomeByMethod}
        byTender={data.finance.incomeByTender}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Profit trend"
            subtitle={
              scoped
                ? `Last 6 months — ${dietitianName}'s revenue, cost of goods sold and gross profit`
                : "Last 6 months, earned not collected — costs are COGS + operating expenses + referrer commissions"
            }
          />
          <CardBody><ProfitTrendChart data={data.profitSeries} scopedToDietitian={scoped} /></CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Machine utilization"
            subtitle={`Sessions delivered ${rangeLabel(range.from, range.to)}${scoped ? " · whole clinic" : ""}`}
          />
          {data.machineUtilization.length === 0 ? (
            <CardBody className="text-sm text-slate-400">No sessions in this period.</CardBody>
          ) : (
            <Table>
              <THead>
                {/* Units are stated in the headers: the middle two columns are
                    sessions, the last pair is a visit count. Without that,
                    "Sessions 12 / Machine visits 5" reads as though 5 of the 12
                    sessions came from machine visits. */}
                <TR>
                  <TH>Machine</TH>
                  <TH>Sessions</TH>
                  <TH>Sessions at machine visits</TH>
                  <TH>Sessions in consultations</TH>
                  <TH>Machine visits</TH>
                </TR>
              </THead>
              <TBody>
                {data.machineUtilization.map((m) => (
                  <TR key={m.machine}>
                    <TD className="font-medium">{m.machine}</TD>
                    <TD className="font-medium">{m.sessions}</TD>
                    <TD className="text-slate-500">{m.machineVisitSessions}</TD>
                    <TD className="text-slate-500">{m.consultationSessions}</TD>
                    <TD className="text-slate-500">{m.machineVisits}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Most-used machines"
            subtitle={`Top 5 by sessions delivered ${rangeLabel(range.from, range.to)}${scoped ? " · whole clinic" : ""}`}
          />
          {data.topMachines.length === 0 ? (
            <CardBody className="text-sm text-slate-400">No sessions in this period.</CardBody>
          ) : (
            <CardBody><TopMachinesChart data={data.topMachines} /></CardBody>
          )}
        </Card>
      </div>

      {!scoped && (
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
      )}

      {!scoped && (
      <div className="mt-6">
        <Card>
          <CardHeader
            title="Referrers"
            subtitle={`Patients registered ${rangeLabel(range.from, range.to)}, grouped by who referred them — "None" (came organically) and "Not specified" are pinned last, not ranked`}
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
      )}
      </div>
    </div>
  );
}
