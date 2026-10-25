import type { NextRequest } from "next/server";
import { refreshTracked } from "@/lib/checks";

// Hobby caps functions at 300s; each run handles what fits and the next run continues
export const maxDuration = 300;

const BUDGET_MS = 270_000;
const MAX_PAIRS = 75;

/** Vercel Cron: check tracked keywords not checked in the last 20 hours. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await refreshTracked({
    limit: MAX_PAIRS,
    deadline: Date.now() + BUDGET_MS,
  });
  return Response.json(result);
}
