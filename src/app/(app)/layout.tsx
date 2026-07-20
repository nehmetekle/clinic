import { redirect } from "next/navigation";
import { getServerUser } from "@/server/session";
import { AppShell } from "@/components/layout/AppShell";

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getServerUser();
  if (!user) redirect("/login");
  return <AppShell>{children}</AppShell>;
}
