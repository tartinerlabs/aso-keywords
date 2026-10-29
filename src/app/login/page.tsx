import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="mx-auto w-full max-w-sm flex-1 px-4 py-16">
      <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 mb-6 text-muted-foreground">
        This app is private. Enter the password to continue.
      </p>
      <Suspense
        fallback={
          <div className="h-32 animate-pulse rounded-card border border-border bg-card" />
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  );
}
