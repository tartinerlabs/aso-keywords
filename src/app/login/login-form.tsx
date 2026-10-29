"use client";

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { login } from "./actions";

const fieldClass =
  "w-full rounded-control text-base sm:text-sm border border-input bg-card px-2.5 py-1.5 outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "min-h-10 w-full rounded-control bg-primary px-5 font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-8";

export function LoginForm() {
  const next = useSearchParams().get("next") ?? "/";
  const [error, action, pending] = useActionState(login, null);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <div>
        <label htmlFor="password" className="mb-1 block text-xs font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className={fieldClass}
        />
      </div>
      {error && (
        <p id="login-error" role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
