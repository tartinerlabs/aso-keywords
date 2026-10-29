"use server";

import { generateText, Output } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { appCompetitors, appKeywords, apps, keywords } from "@/db/schema";
import { describeAiError, MODEL } from "@/lib/ai";
import {
  countriesField,
  pairsField,
  phrasesField,
  refreshTracked,
} from "@/lib/checks";
import { lookup, ThrottledError } from "@/lib/itunes";
import { normalize } from "@/lib/scoring";

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

  const combos = phrases.length * countries.length;
  if (combos > MAX_TRACKED_PER_ADD) {
    return {
      error: `That is ${combos} keyword and storefront pairs. Add at most ${MAX_TRACKED_PER_ADD} at a time.`,
    };
  }

  if (formData.get("localize") === "on") {
    const local = await localize(phrases, countries);
    if (typeof local === "string") return { error: local };
    return track(appId, local);
  }
  return track(
    appId,
    phrases.flatMap((phrase) =>
      countries.map((country) => ({ phrase, country })),
    ),
  );
}

const localizedSchema = z.object({
  results: z.array(
    z.object({
      label: z.string().describe("The English keyword, exactly as given"),
      country: z.string().describe("Storefront code, exactly as given"),
      phrase: z.string().describe("The native App Store search phrase"),
    }),
  ),
});

/** One native phrase per English keyword and storefront, labelled with the English keyword. */
async function localize(
  labels: string[],
  countries: string[],
): Promise<Pair[] | string> {
  let results: z.infer<typeof localizedSchema>["results"];
  try {
    const { output } = await generateText({
      model: MODEL,
      instructions:
        "You are an App Store keyword researcher. For each English keyword and storefront, write the one phrase people in that storefront most likely type into App Store search for it, in the storefront's primary language and script. Prefer natural local wording over literal translation; keep the English keyword where locals search in English. Lowercase, 1 to 4 words, no brand names.",
      prompt: `Keywords: ${labels.map((l) => `"${l}"`).join(", ")}\nStorefronts: ${countries.join(", ")}\nReturn one entry per keyword and storefront.`,
      output: Output.object({ schema: localizedSchema }),
      maxOutputTokens: 2000,
      timeout: 45_000,
    });
    results = output.results;
  } catch (e) {
    console.error("localize", e);
    return describeAiError(e);
  }

  // Keep only requested keywords and storefronts, one phrase each
  const pairs = new Map<string, Pair>();
  for (const r of results) {
    const label = normalize(r.label);
    const country = r.country.trim().toLowerCase();
    const phrase = normalize(r.phrase);
    if (!labels.includes(label) || !countries.includes(country)) continue;
    if (!phrase || phrase.length > 100) continue;
    pairs.set(`${label}:${country}`, { country, phrase, label });
  }
  if (pairs.size === 0) return "The AI returned no usable phrases. Try again.";
  return [...pairs.values()];
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

/** A phrase to track in a storefront; label groups local phrases of one keyword. */
type Pair = { country: string; phrase: string; label?: string };

/** Save the keywords and link them to the app. */
async function track(appId: number, input: Pair[]): Promise<FormState> {
  // One per storefront and phrase; a second insert of the same row would fail
  const pairs = [
    ...new Map(input.map((p) => [`${p.country}:${p.phrase}`, p])).values(),
  ];
  const rows = await db
    .insert(keywords)
    .values(pairs.map(({ country, phrase }) => ({ country, phrase })))
    // No-op update so RETURNING gives the ids of existing rows too
    .onConflictDoUpdate({
      target: [keywords.country, keywords.phrase],
      set: { phrase: sql`excluded.phrase` },
    })
    .returning({
      id: keywords.id,
      country: keywords.country,
      phrase: keywords.phrase,
    });
  const labels = new Map(
    pairs.map((p) => [`${p.country}:${p.phrase}`, p.label]),
  );

  const added = await db
    .insert(appKeywords)
    .values(
      rows.map((r) => {
        const label = labels.get(`${r.country}:${r.phrase}`);
        // The phrase itself is the default label, so store only a different one
        return {
          appId,
          keywordId: r.id,
          label: label && label !== r.phrase ? label : null,
        };
      }),
    )
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

/** Stop tracking a keyword in every storefront. */
export async function removeLabel(appId: number, label: string) {
  await db.execute(sql`
    delete from app_keywords ak using keywords k
    where k.id = ak.keyword_id and ak.app_id = ${appId}
      and coalesce(ak.label, k.phrase) = ${label}`);
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
