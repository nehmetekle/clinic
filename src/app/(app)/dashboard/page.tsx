"use client";

import { useSession } from "@/lib/session";
import { SecretaryDashboard } from "./SecretaryDashboard";
import { DietitianDashboard } from "./DietitianDashboard";
import { AdminDashboard } from "./AdminDashboard";

export default function DashboardPage() {
  const { user } = useSession();
  if (!user) return null;
  if (user.role === "secretary") return <SecretaryDashboard />;
  if (user.role === "dietitian") return <DietitianDashboard />;
  return <AdminDashboard />;
}
