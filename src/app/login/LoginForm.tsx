"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Lock, Mail, ShieldCheck } from "lucide-react";
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
    <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-[#f7fbfa] px-5 py-10 sm:px-6">
      <div
        aria-hidden="true"
        className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-brand-200/50 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-amber-100/60 blur-3xl"
      />
      <div className="relative w-full max-w-md">
        <div className="relative mx-auto mb-5 h-40 w-full max-w-sm overflow-hidden">
          <Image
            src="/images/layaka-logo1.png"
            alt="Layaka Wellness Center"
            fill
            priority
            className="object-cover object-center"
            sizes="(max-width: 640px) 90vw, 384px"
          />
        </div>

        <section className="rounded-3xl border border-white bg-white/90 p-6 shadow-[0_24px_70px_-28px_rgba(15,118,110,0.35)] backdrop-blur sm:p-9">
          {pendingToken ? (
            <>
              <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <h1 className="text-center text-2xl font-semibold tracking-tight text-slate-900">
                Two-factor verification
              </h1>
              <p className="mt-2 text-center text-sm leading-6 text-slate-500">
                Enter the 6-digit code from your authenticator app, or one of your backup codes.
              </p>
              <form className="mt-7 space-y-5" onSubmit={handleCodeSubmit}>
                <div>
                  <Label htmlFor="code">Code</Label>
                  <div className="relative">
                    <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="code"
                      className="h-12 rounded-xl pl-10"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      autoComplete="one-time-code"
                      autoFocus
                      required
                    />
                  </div>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" className="h-12 w-full rounded-xl shadow-md shadow-brand-600/15" disabled={submitting}>
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
              <h1 className="text-center text-3xl font-semibold tracking-tight text-slate-900">
                Welcome back
              </h1>
              <p className="mt-2 text-center text-sm leading-6 text-slate-500">
                Here&apos;s to a healthy, productive day.
              </p>

              <form className="mt-7 space-y-5" onSubmit={handlePasswordSubmit}>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="email"
                      type="email"
                      className="h-12 rounded-xl pl-10"
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
                      className="h-12 rounded-xl pl-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button type="submit" className="h-12 w-full rounded-xl shadow-md shadow-brand-600/15" disabled={submitting}>
                  {submitting ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
