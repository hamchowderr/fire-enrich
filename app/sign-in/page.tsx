"use client";

import { type FormEvent, useState } from "react";

import Input from "@/components/ui/input";

/**
 * Sign-in with an emailed 6-digit code (`lib/auth`). Only the addresses this
 * deployment allows get a code; the page says the same thing for any address,
 * so it never reveals which ones those are.
 */
export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(data?.message ?? "Something went wrong. Try again.");
      return false;
    } catch {
      setError("Could not reach the server. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    if (await post("/email-otp/send-verification-otp", { email, type: "sign-in" })) setStep("code");
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (await post("/sign-in/email-otp", { email, otp: code.trim() })) {
      const next = new URLSearchParams(window.location.search).get("next");
      // Only a path on this site, never another origin.
      window.location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-16">
      <div className="w-full max-w-[380px] flex flex-col gap-16">
        <h1 className="text-title-h4 font-semibold">Sign in to Fire Enrich</h1>
        {step === "email" ? (
          <form onSubmit={sendCode} className="flex flex-col gap-12">
            <p className="text-body-medium text-black-alpha-64">We&apos;ll email you a 6-digit code.</p>
            <Input
              type="email"
              required
              autoFocus
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <SubmitButton busy={busy}>Email me a code</SubmitButton>
          </form>
        ) : (
          <form onSubmit={signIn} className="flex flex-col gap-12">
            <p className="text-body-medium text-black-alpha-64">
              If {email} can sign in here, a code is on its way. It expires in 10 minutes.
            </p>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <SubmitButton busy={busy}>Sign in</SubmitButton>
            <button
              type="button"
              className="text-body-small text-black-alpha-64 underline self-start"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-body-small text-[#c2410c]">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="h-40 rounded-10 bg-heat-100 text-white font-medium disabled:opacity-60 transition-opacity"
    >
      {busy ? "Working…" : children}
    </button>
  );
}
