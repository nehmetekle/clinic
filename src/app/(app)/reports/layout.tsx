import { requireRole } from "../page-guard";

/** Admin only — enforced on the SERVER, so the page is never delivered to a role
 * that may not see it. See requireRole. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireRole(["admin"]);
  return <>{children}</>;
}
