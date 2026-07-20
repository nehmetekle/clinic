import { redirect } from "next/navigation";
import { getServerUser } from "@/server/session";
import { roleHome } from "@/lib/nav";
import { LoginForm } from "./LoginForm";

// Authoritative, server-side: if there's already a valid session, landing on
// /login by ANY means (reload, back button, a bookmark, revisiting the URL)
// should bounce straight to the dashboard instead of showing the form again —
// the form's own post-submit router.push only covers a fresh sign-in, not
// revisiting this page while already authenticated.
export default async function LoginPage() {
  const user = await getServerUser();
  if (user) redirect(roleHome(user.role));
  return <LoginForm />;
}
