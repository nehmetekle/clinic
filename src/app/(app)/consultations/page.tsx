"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { bmiCategory, formatDate } from "@/lib/utils";

export default function ConsultationsPage() {
  const router = useRouter();
  const { data, loading, error } = useApi(() => api.listConsultations());

  return (
    <div>
      <PageHeader title="Consultations" subtitle={`${data?.length ?? 0} consultation records`} />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Client</TH>
                <TH>Visit</TH>
                <TH>Dietitian</TH>
                <TH>Weight</TH>
                <TH>BMI</TH>
                <TH>Category</TH>
              </TR>
            </THead>
            <TBody>
              {(data ?? []).map((c) => (
                <TR key={c.id} onClick={() => router.push(`/clients/${c.clientId}`)}>
                  <TD>{formatDate(c.date)}</TD>
                  <TD className="font-medium">{c.clientName}</TD>
                  <TD>#{c.visitNumber}</TD>
                  <TD className="text-slate-500">{c.dietitianName}</TD>
                  <TD>{c.weightKg ? `${c.weightKg} kg` : "—"}</TD>
                  <TD>{c.bmi ?? "—"}</TD>
                  <TD className="text-slate-500">{bmiCategory(c.bmi)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
