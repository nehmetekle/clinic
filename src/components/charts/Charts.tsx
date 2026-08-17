"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatNumber } from "@/lib/utils";

const axis = { fontSize: 12, fill: "#64748b" };
const formatChartNumber = (value: number | string) =>
  typeof value === "number" ? formatNumber(value) : value;

/**
 * Earned profit trend. Revenue, total costs and net profit — never collections:
 * cash is a different question and lives in its own section of the report.
 *
 * Net profit is drawn as the emphasized series because it is the line the reader
 * is actually looking for; revenue and costs are the two it is derived from, so
 * they sit behind it, thinner. A zero reference line makes a loss month read as a
 * loss at a glance rather than requiring the axis to be traced.
 */
export function ProfitTrendChart({
  data,
  scopedToDietitian = false,
}: {
  data: { month: string; revenue: number; costs: number; netProfit: number }[];
  // Scoped to one dietitian, `costs` is COGS only and `netProfit` is gross
  // profit — opex/referrer commissions are deliberately left out (see
  // dashboard.ts). Labels must say so; there is no per-dietitian net profit.
  scopedToDietitian?: boolean;
}) {
  const costsLabel = scopedToDietitian ? "COGS" : "Total costs";
  const profitLabel = scopedToDietitian ? "Gross profit" : "Net profit";
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} />
        <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={formatChartNumber} />
        <Tooltip formatter={formatChartNumber} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />
        <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#0d9488" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="costs" name={costsLabel} stroke="#e11d48" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="netProfit" name={profitLabel} stroke="#4338ca" strokeWidth={2.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * The clinic's busiest machines. Bar length is SESSIONS delivered, which is the
 * ranking too — a machine used three times in one long visit did three sessions
 * of work, and ranking by visit count would hide that.
 *
 * Visit count is deliberately secondary, in the tooltip rather than as a second
 * bar: it is a different unit, and putting it beside the session bar invites the
 * two to be read against the same axis.
 *
 * Horizontal, because machine names are words and a vertical axis turns them into
 * unreadable angled labels the moment a clinic names one "Cryolipolysis".
 */
export function TopMachinesChart({
  data,
}: {
  data: { machine: string; sessions: number; machineVisits: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
        <XAxis type="number" tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="machine"
          tick={axis}
          axisLine={false}
          tickLine={false}
          width={110}
        />
        <Tooltip
          formatter={(value: number | string) => [formatChartNumber(value), "Sessions"]}
          labelFormatter={(machine: string) => {
            const d = data.find((r) => r.machine === machine);
            if (!d) return machine;
            const visits = `${d.machineVisits} machine visit${d.machineVisits === 1 ? "" : "s"}`;
            return `${machine} · ${visits}`;
          }}
        />
        <Bar dataKey="sessions" name="Sessions" fill="#0d9488" radius={[0, 6, 6, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// Same visual language as TopMachinesChart (horizontal bars, teal) because it
// answers the same shape of question — "what did the clinic lean on this period"
// — one card down. Counts ORDERS, not money, so nothing here is redacted.
export function TopBloodTestsChart({
  data,
}: {
  data: { name: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
        <XAxis type="number" tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          tick={axis}
          axisLine={false}
          tickLine={false}
          width={140}
        />
        <Tooltip formatter={(value: number | string) => [formatChartNumber(value), "Times ordered"]} />
        <Bar dataKey="count" name="Times ordered" fill="#0d9488" radius={[0, 6, 6, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BreakdownDonut({
  data,
}: {
  data: { name: string; value: number; color: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={55}
          outerRadius={85}
          paddingAngle={2}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function WeightTrendChart({
  data,
}: {
  data: { label: string; weight: number; goal: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} />
        <YAxis tick={axis} axisLine={false} tickLine={false} domain={["dataMin - 3", "dataMax + 3"]} />
        <Tooltip />
        <Area type="monotone" dataKey="weight" stroke="#0d9488" strokeWidth={2.5} fill="url(#w)" />
        <Line type="monotone" dataKey="goal" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
