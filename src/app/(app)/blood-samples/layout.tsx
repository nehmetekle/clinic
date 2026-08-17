import { requireRole } from "../page-guard";

/** Front desk and admin, matching the nav's own rule for this route. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireRole(["secretary", "admin"]);
  return <>{children}</>;
}
