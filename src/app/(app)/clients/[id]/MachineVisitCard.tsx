"use client";

import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";
import { NO_MACHINE_LABEL } from "@/lib/types";
import type { MachineVisit } from "@/lib/types";

/**
 * A machine visit in the client's visit history, alongside consultations. The
 * badge is what says no consultation happened — there is no explanatory copy.
 */
export function MachineVisitCard({
  visit,
  canVoid,
  onVoid,
}: {
  visit: MachineVisit;
  canVoid: boolean;
  onVoid: (visit: MachineVisit) => void;
}) {
  const voided = visit.status === "voided";
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 font-medium text-slate-800">
              Machine visit · {formatDateTime(visit.date)}
              {voided && <Badge tone="red">Voided</Badge>}
            </p>
            <p className="text-xs text-slate-500">{visit.recordedByName}</p>
          </div>
          {canVoid && !voided && (
            <Button size="sm" variant="ghost" onClick={() => onVoid(visit)}>
              Void
            </Button>
          )}
        </div>
        <div className={voided ? "mt-3 space-y-1 text-sm text-slate-400 line-through" : "mt-3 space-y-1 text-sm text-slate-600"}>
          {visit.items.map((i) => (
            <p key={i.id}>
              <span className="font-medium text-slate-700">{i.machine ?? NO_MACHINE_LABEL}</span> ×{i.sessions}
              {i.billedSessions > 0 && (
                <span className="text-slate-400">
                  {" · "}
                  {formatMoney(i.billedSessions * i.unitPrice, i.currency)} charged
                </span>
              )}
            </p>
          ))}
        </div>
        {visit.note && <p className="mt-2 text-sm text-slate-600">{visit.note}</p>}
        {voided && visit.voidedByName && (
          <p className="mt-2 text-xs text-slate-400">
            Voided by {visit.voidedByName}
            {visit.voidedAt ? ` · ${formatDate(visit.voidedAt)}` : ""}
            {visit.voidReason ? ` · ${visit.voidReason}` : ""}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
