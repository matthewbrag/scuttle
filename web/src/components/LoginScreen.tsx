import React, { useState } from "react";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        setError(body.error || `login failed (${res.status})`);
        return;
      }
      onSuccess();
    } catch {
      setError("couldn't reach the server");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-title">✦ scuttle</div>
        <input
          type="password"
          className="login-input"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          autoFocus
        />
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit-btn" onClick={submit} disabled={submitting || !password}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}
