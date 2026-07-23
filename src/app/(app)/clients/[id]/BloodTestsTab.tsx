"use client";

import { Fragment } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { BloodSampleFiles } from "@/components/BloodSampleFiles";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { BloodSampleStatus } from "@/lib/types";

const STATUS: Record<BloodSampleStatus, { tone: "amber" | "blue" | "green"; label: string }> = {
  pending: { tone: "amber", label: "Awaiting send" },
  sent: { tone: "blue", label: "At lab" },
  received: { tone: "green", label: "Results in" },
};

/**
 * Read-only blood-test history for a patient. Reads the same tracking records
 * the secretary maintains on the Blood Samples board, so the collection and
 * result times shown here update as soon as she logs them — handy when a patient
 * asks "when was my blood taken / when did the results come back?".
 */
export function BloodTestsTab({ clientId }: { clientId: string }) {
  const { data, loading, error } = useApi(() => api.listBloodSamples(clientId), [clientId]);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  const samples = data ?? [];

  return (
    <Card>
      <CardHeader
        title="Blood tests"
        subtitle="Every blood collection ordered, with sample and result tracking"
      />
      {samples.length === 0 ? (
        <CardBody>
          <p className="py-6 text-center text-sm text-slate-400">
            No blood tests on record for this patient.
          </p>
        </CardBody>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Ordered</TH>
              <TH>Tests</TH>
              <TH>Status</TH>
              <TH>Sample collected / sent</TH>
              <TH>Results received</TH>
            </TR>
          </THead>
          <TBody>
            {samples.map((s) => (
              <Fragment key={s.id}>
              <TR>
                <TD className="text-slate-500">{formatDate(s.orderedAt)}</TD>
                <TD className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {s.tests.length > 0 ? (
                      s.tests.map((t) => (
                        <Badge key={t} tone="gray">
                          {t}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs italic text-slate-400">Not specified</span>
                    )}
                  </div>
                  {s.notes && <p className="mt-1 text-xs text-slate-400">{s.notes}</p>}
                </TD>
                <TD>
                  <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                </TD>
                <TD className="text-slate-500">
                  {s.sentAt ? (
                    formatDateTime(s.sentAt)
                  ) : (
                    <span className="text-slate-300">— not sent yet</span>
                  )}
                </TD>
                <TD className="text-slate-500">
                  {s.receivedAt ? (
                    formatDateTime(s.receivedAt)
                  ) : (
                    <span className="text-slate-300">{s.sentAt ? "Awaiting results" : "—"}</span>
                  )}
                </TD>
              </TR>
              {/* Result files only exist once results are in — no files row for a
                  sample still awaiting send or at the lab. */}
              {s.status === "received" && (
                <TR>
                  <TD colSpan={5} className="bg-slate-50/40 pt-0">
                    <BloodSampleFiles sampleId={s.id} status={s.status} />
                  </TD>
                </TR>
              )}
              </Fragment>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
