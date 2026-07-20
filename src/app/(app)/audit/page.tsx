"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

export default function AuditPage() {
  const { data, loading, error } = useApi(() => api.listAudit());

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Append-only record of important actions." />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>User</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Details</TH>
              </TR>
            </THead>
            <TBody>
              {(data ?? []).map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap text-slate-500">{formatDateTime(a.timestamp)}</TD>
                  <TD className="font-medium">{a.user}</TD>
                  <TD>{a.action}</TD>
                  <TD><Badge tone="gray">{a.entityType}</Badge></TD>
                  <TD className="text-slate-500">{a.entityLabel}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
