"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Input } from "@/components/ui/Field";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { useClientSearch } from "@/lib/use-client-search";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { age, cn, formatDate, initials } from "@/lib/utils";

const FILTERS = [
  "All",
  "Active",
  "Owes money",
] as const;

function ClientsList() {
  const router = useRouter();
  // `?filter=owes` deep-links straight into the debtors list — used by the
  // "Outstanding debt" stat cards on Payments / Dashboard / Reports.
  const searchParams = useSearchParams();
  const { user } = useSession();
  // Money owed is the secretary's / admin's concern only — the dietitian is
  // front-desk-blind to it, so the "Owes money" filter, the debt fetch, and the
  // "Owes" column are all gated on this.
  const canHandleMoney = user?.role === "secretary" || user?.role === "admin";

  const [q, setQ] = useState("");
  // Server-side search (shared with phone booking & payments). minChars: 0 → an
  // empty box lists everyone and typing narrows it on the server.
  const { results, loading, error } = useClientSearch(q, { minChars: 0 });
  // "Owes money" is backed by the ClientDebt system (the single source of truth
  // for money owed). Only fetched for money roles; the endpoint 403s otherwise.
  const debts = useApi(
    () => (canHandleMoney ? api.listOutstandingDebts() : Promise.resolve([])),
    [canHandleMoney],
  );
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(
    searchParams.get("filter") === "owes" ? "Owes money" : "All",
  );

  // If the role switches to one without money access while "Owes money" is
  // selected (demo role switcher), fall back to "All" so the now-hidden filter
  // can't leave the list stuck showing nothing.
  useEffect(() => {
    if (!canHandleMoney && filter === "Owes money") setFilter("All");
  }, [canHandleMoney, filter]);

  const owingClientIds = useMemo(
    () => new Set((debts.data ?? []).map((d) => d.clientId)),
    [debts.data],
  );

  const rows = useMemo(() => {
    return results.filter(
      (c) =>
        filter === "All" ||
        (filter === "Active" && c.active) ||
        (filter === "Owes money" && owingClientIds.has(c.id)),
    );
  }, [results, filter, owingClientIds]);

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle={q.trim() ? `${rows.length} matching` : `${rows.length} clients`}
        action={
          <Button onClick={() => router.push("/clients/new")}>
            <UserPlus className="h-4 w-4" /> Add New Client
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search name, phone, email…"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.filter((f) => f !== "Owes money" || canHandleMoney).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-500 hover:border-slate-300",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Full-screen loader only on the first load; later searches refresh the
          table in place so the search box keeps focus. */}
      {loading && rows.length === 0 && q.trim() === "" ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Client</TH>
                <TH>Phone</TH>
                <TH>Age</TH>
                <TH>Bundle</TH>
                <TH>Sessions</TH>
                {canHandleMoney && <TH>Owes</TH>}
                <TH>Status</TH>
                <TH>Registered</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((c) => {
                const cp = c.packages[0];
                return (
                  <TR key={c.id} onClick={() => router.push(`/clients/${c.id}`)}>
                    <TD>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                          {initials(c.firstName, c.lastName)}
                        </div>
                        <div>
                          <p className="font-medium text-slate-800">
                            {c.firstName} {c.lastName}
                          </p>
                          <p className="text-xs text-slate-400">{c.email ?? "—"}</p>
                        </div>
                      </div>
                    </TD>
                    <TD className="text-slate-500">{c.phone}</TD>
                    <TD>{age(c.dateOfBirth) ?? "—"}</TD>
                    <TD className="text-slate-500">{cp?.packageName ?? "—"}</TD>
                    <TD>{cp ? `${cp.usedSessions}/${cp.totalSessions}` : "—"}</TD>
                    {canHandleMoney && (
                      <TD>
                        {owingClientIds.has(c.id) ? (
                          <Badge tone="red">Owes</Badge>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </TD>
                    )}
                    <TD>
                      {c.active ? (
                        <Badge tone="green">Active</Badge>
                      ) : c.inactive ? (
                        <Badge tone="gray">Inactive</Badge>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </TD>
                    <TD className="text-slate-500">{formatDate(c.registeredAt)}</TD>
                  </TR>
                );
              })}
              {rows.length === 0 && (
                <TR>
                  <TD colSpan={canHandleMoney ? 8 : 7} className="py-8 text-center text-slate-400">
                    No clients match your search.
                  </TD>
                </TR>
              )}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

export default function ClientsPage() {
  // useSearchParams (read in ClientsList) must sit under a Suspense boundary.
  return (
    <Suspense fallback={<Loading />}>
      <ClientsList />
    </Suspense>
  );
}
