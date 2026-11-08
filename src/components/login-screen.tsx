"use client";

import { useState, type FormEvent } from "react";
import { FlaskConical, LockKeyhole, ShieldCheck } from "lucide-react";

export function LoginScreen({ passwordConfigured, production }: { passwordConfigured: boolean; production: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to sign in.");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="brand-mark"><FlaskConical size={23} /></div>
        <p className="eyebrow">WEBSITE QA WORKSPACE</p>
        <h1>Website Testing Labs</h1>
        <p className="login-copy">Seven focused testing tools. One simple place to inspect your website.</p>
        <form onSubmit={submit} className="login-form">
          {passwordConfigured ? (
            <label>
              <span>Access password</span>
              <div className="password-input">
                <LockKeyhole size={17} />
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" required />
              </div>
            </label>
          ) : (
            <div className={production ? "form-error" : "local-note"}>
              <ShieldCheck size={17} />
              {production ? "Production is not configured. Set APP_ACCESS_PASSWORD and SESSION_SECRET in Vercel Environment Variables." : "Local development access is enabled. No password is configured."}
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          {(!production || passwordConfigured) && (
            <button className="primary-button full-button" type="submit" disabled={loading}>
              {loading ? "Signing in…" : passwordConfigured ? "Unlock workspace" : "Continue"}
            </button>
          )}
        </form>
        <p className="login-foot">Production deployments require an access password.</p>
      </section>
    </main>
  );
}
