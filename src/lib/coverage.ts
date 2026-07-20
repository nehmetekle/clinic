/**
 * Greedy per-source coverage allocation — the single source of truth for how many
 * of a treatment's sessions are covered (prepaid) vs charged this visit.
 *
 * For each row in order, it covers as many of its `used` sessions as the row's
 * source (a package, a bundle, or session-plan credit) still has remaining, and
 * charges the rest. `remaining` is a mutable pool map that callers pre-seed with
 * each source's starting balance and share across rows drawing from the same
 * source, so two treatments on one package split its balance in order. A row with
 * no source (`sourceKey` null) or nothing used is fully charged.
 *
 * Both the consultation editor's live basket preview and the server's billing on
 * save run through this, so the covered/charged split can never drift between the
 * price the dietitian previews and the amount the visit is actually charged.
 */
export function allocateCoverage(
  rows: { sourceKey: string | null; used: number }[],
  remaining: Map<string, number>,
): { covered: number; charged: number }[] {
  return rows.map(({ sourceKey, used }) => {
    const need = Math.max(0, used);
    if (!sourceKey || need <= 0) return { covered: 0, charged: need };
    const avail = remaining.get(sourceKey) ?? 0;
    const covered = Math.min(need, avail);
    remaining.set(sourceKey, avail - covered);
    return { covered, charged: need - covered };
  });
}
