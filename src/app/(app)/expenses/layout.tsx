import { requireRole } from "../page-guard";

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireRole(["secretary", "admin"]);
  return <>{children}</>;
}
