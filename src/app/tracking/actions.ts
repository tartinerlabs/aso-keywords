"use server";

import { and, eq, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { appCompetitors, appKeywords, apps, keywords } from "@/db/schema";
import {
  countriesField,
  pairsField,
  phrasesField,
  refreshTracked,
} from "@/lib/checks";
import { lookup, ThrottledError } from "@/lib/itunes";

const MAX_TRACKED_PER_ADD = 50;
const MAX_REFRESH = 15;
// Leave room under the page's maxDuration for the last request and the render
const REFRESH_BUDGET_MS = 100_000;

export type FormState = { error?: string; message?: string };

const appIdField = z
  .string()
  .trim()
  .regex(/^\d{1,15}$/, "App ID must be a number")
  .transform(Number);

const NOT_MINE = "Add the app on the Tracking page first";

/** Whether the ID is one of my apps; bound IDs arrive from the client, so check them. */
async function isMine(appId: number) {
  if (!Number.isSafeInteger(appId) || appId <= 0) return false;
  const [row] = await db
    .select({ trackId: apps.trackId })
    .from(apps)
    .where(and(eq(apps.trackId, appId), eq(apps.isMine, true)));
  return Boolean(row);
}

/** The app's row, looked up on the App Store (US) when it is not saved yet. */
async function findApp(
  id: number,
): Promise<{ name: string; icon: string } | string> {
  const [saved] = await db
    .select({ name: apps.name, icon: apps.icon })
    .from(apps)
    .where(eq(apps.trackId, id));
  if (saved) return saved;
  try {
    const found = await lookup(id);
    return found ?? `No app with ID ${id} on the US App Store`;
  } catch (e) {
    if (e instanceof ThrottledError) {
      return "App Store lookup is rate limited. Try again in a minute.";
    }
    console.error(`findApp ${id}`, e);
    return "App Store lookup failed";
  }
}

export async function addApp(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = appIdField.safeParse(String(formData.get("appId") ?? ""));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const trackId = parsed.data;

  const app = await findApp(trackId);
  if (typeof app === "string") return { error: app };

  await db
    .insert(apps)
    .values({ trackId, ...app, isMine: true })
    .onConflictDoUpdate({ target: apps.trackId, set: { isMine: true } });

  redirect(`/tracking?app=${trackId}`);
}

export async function addKeywords(
  appId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = z
    .object({ phrases: phrasesField, countries: countriesField })
    .safeParse({
      phrases: String(formData.get("phrases") ?? ""),
      countries: String(formData.get("countries") ?? ""),
    });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { phrases, countries } = parsed.data;
  if (!(await isMine(appId))) return { error: NOT_MINE };

  const pairs = phrases.flatMap((phrase) =>
    countries.map((country) => ({ phrase, country })),
  );
  if (pairs.length > MAX_TRACKED_PER_ADD) {
    return {
      error: `That is ${pairs.length} keyword and storefront pairs. Add at most ${MAX_TRACKED_PER_ADD} at a time.`,
    };
  }

  return track(appId, pairs);
}

/** Track explicit storefront and phrase pairs, e.g. picked from AI ideas. */
export async function trackPairs(
  appId: number,
  pairs: { country: string; phrase: string }[],
): Promise<FormState> {
  const parsed = z
    .object({
      appId: z.number().int().positive(),
      pairs: pairsField
        .min(1, "Select at least one keyword")
        .max(
          MAX_TRACKED_PER_ADD,
          `Add at most ${MAX_TRACKED_PER_ADD} at a time`,
        ),
    })
    .safeParse({ appId, pairs });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!(await isMine(appId))) return { error: NOT_MINE };
  const unique = [
    ...new Map(
      parsed.data.pairs.map((p) => [`${p.country}:${p.phrase}`, p]),
    ).values(),
  ];
  return track(appId, unique);
}

/** Save the keywords and link them to the app. */
async function track(
  appId: number,
  pairs: { country: string; phrase: string }[],
): Promise<FormState> {
  const rows = await db
    .insert(keywords)
    .values(pairs)
    // No-op update so RETURNING gives the ids of existing rows too
    .onConflictDoUpdate({
      target: [keywords.country, keywords.phrase],
      set: { phrase: sql`excluded.phrase` },
    })
    .returning({ id: keywords.id });

  const added = await db
    .insert(appKeywords)
    .values(rows.map((r) => ({ appId, keywordId: r.id })))
    .onConflictDoNothing()
    .returning({ keywordId: appKeywords.keywordId });

  refresh();
  const already = pairs.length - added.length;
  if (added.length === 0) return { message: "Already tracked." };
  return {
    message: `Tracking ${added.length} new ${added.length === 1 ? "pair" : "pairs"}${already > 0 ? `, ${already} already tracked` : ""}. They are checked in the next refresh.`,
  };
}

export async function removeKeyword(appId: number, keywordId: number) {
  await db
    .delete(appKeywords)
    .where(
      and(eq(appKeywords.appId, appId), eq(appKeywords.keywordId, keywordId)),
    );
  refresh();
}

export async function addCompetitor(
  appId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = appIdField.safeParse(
    String(formData.get("competitorId") ?? ""),
  );
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const competitorId = parsed.data;
  if (competitorId === appId) {
    return { error: "That is this app. Enter another app's ID." };
  }
  if (!(await isMine(appId))) return { error: NOT_MINE };

  const app = await findApp(competitorId);
  if (typeof app === "string") return { error: app };

  await db
    .insert(apps)
    .values({ trackId: competitorId, ...app })
    .onConflictDoNothing();
  await db
    .insert(appCompetitors)
    .values({ appId, competitorId })
    .onConflictDoNothing();

  refresh();
  return { message: `Comparing with ${app.name}` };
}

export async function removeCompetitor(appId: number, competitorId: number) {
  await db
    .delete(appCompetitors)
    .where(
      and(
        eq(appCompetitors.appId, appId),
        eq(appCompetitors.competitorId, competitorId),
      ),
    );
  refresh();
}

/** Check up to 15 of the app's keywords that have no check in the last 20 hours. */
export async function refreshApp(
  appId: number,
  _prev: FormState,
): Promise<FormState> {
  if (!(await isMine(appId))) return { error: NOT_MINE };
  const { due, checked, failed, throttled, more } = await refreshTracked({
    appId,
    limit: MAX_REFRESH,
    deadline: Date.now() + REFRESH_BUDGET_MS,
  });
  refresh();

  if (due === 0) {
    return { message: "Everything was checked in the last 20 hours." };
  }
  const parts = [`Checked ${checked} of ${due}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (throttled) parts.push("Apple is throttling searches, try again later");
  else if (more || checked + failed < due) {
    parts.push("run again for the rest");
  }
  return { message: `${parts.join(", ")}.` };
}
