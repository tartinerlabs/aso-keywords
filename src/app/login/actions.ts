"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  isPassword,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionToken,
} from "@/lib/session";

export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  const token = sessionToken();
  if (!token) return "Sign-in is off until APP_PASSWORD is set.";
  if (!isPassword(String(formData.get("password") ?? ""))) {
    return "That password isn't right.";
  }

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });

  // Only same-site paths, never "//host" or absolute URLs
  const next = String(formData.get("next") ?? "");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}
