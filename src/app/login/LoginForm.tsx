"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Leaf, Lock, Mail, ShieldCheck } from "lucide-react";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { roleHome } from "@/lib/nav";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

export function LoginForm() {
  const { refresh } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.login({ email, password });
      if ("requires2FA" in result) {
        setPendingToken(result.pendingToken);
      } else {
        await refresh();
        router.push(roleHome(result.user.role));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setSubmitting(true);
    try {
      const { user } = await api.verifyTwoFactor({ pendingToken, code });
      await refresh();
      router.push(roleHome(user.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Brand panel */}
      <div className="relative flex flex-col justify-between bg-brand-700 p-8 text-white lg:w-[44%] lg:p-12">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
            <Leaf className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">NutriClinic</span>
        </div>
        <div className="my-10 lg:my-0">
          <h1 className="max-w-sm text-3xl font-semibold leading-tight">
            Run your nutrition clinic from one dashboard.
          </h1>
          <p className="mt-4 max-w-sm text-brand-100">
            Front desk, consultations and business reporting — connected in one
            smooth workflow.
          </p>
          <ul className="mt-8 space-y-2 text-sm text-brand-50">
            <li>• Clients, packages & sessions tracking</li>
            <li>• Daily queue and appointment scheduling</li>
            <li>• Consultations, measurements & progress</li>
            <li>• Payments, expenses & owner reports</li>
          </ul>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md">
          {pendingToken ? (
            <>
              <h2 className="text-2xl font-semibold text-slate-900">Two-factor verification</h2>
              <p className="mt-1 text-sm text-slate-500">
                Enter the 6-digit code from your authenticator app, or one of your backup codes.
              </p>
              <form className="mt-8 space-y-4" onSubmit={handleCodeSubmit}>
                <div>
                  <Label htmlFor="code">Code</Label>
                  <div className="relative">
                    <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="code"
                      className="pl-9"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      autoComplete="one-time-code"
                      autoFocus
                      required
                    />
                  </div>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Verifying…" : "Verify"}
                </Button>
                <button
                  type="button"
                  className="w-full text-center text-sm text-slate-500 hover:text-slate-700"
                  onClick={() => {
                    setPendingToken(null);
                    setCode("");
                    setError(null);
                  }}
                >
                  Back to sign in
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-semibold text-slate-900">Welcome back</h2>
              <p className="mt-1 text-sm text-slate-500">
                Sign in to your clinic workspace.
              </p>

              <form className="mt-8 space-y-4" onSubmit={handlePasswordSubmit}>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="email"
                      type="email"
                      className="pl-9"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="username"
                      required
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="password"
                      type="password"
                      className="pl-9"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
