import { requireRole } from "../page-guard";

/** Clinical staff only, matching the nav's own rule for this route. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireRole(["dietitian", "admin"]);
  return <>{children}</>;
}
