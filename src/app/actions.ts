"use server";

import { generateText, Output } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { keywordChecks, keywords, type TopApp } from "@/db/schema";
import { describeAiError, MODEL } from "@/lib/ai";
import {
  APPLE_GAP_MS,
  countriesField,
  pairsField,
  phrasesField,
  recordCheck,
  sleep,
} from "@/lib/checks";
import { InvalidStorefrontError, ThrottledError } from "@/lib/itunes";
import { difficultyLabel, normalize, rankOf } from "@/lib/scoring";

const MAX_CHECKS = 15;
const CACHE_MS = 24 * 60 * 60 * 1000;

export type Row = {
  country: string;
  phrase: string;
  /** English seed the phrase was localized from */
  seed?: string;
} & (
  | { error: string }
  | {
      error?: undefined;
      /** 1-based place of the app, null when unranked or no app was given */
      rank: number | null;
      volume: number;
      difficulty: number;
      label: "open" | "contested" | "crowded";
      leader: { name: string; icon: string } | null;
      /** Median rating count of the top 10 */
      medianRatings: number | null;
      /** ISO timestamp of the check */
      checkedAt: string;
      /** Served from the last 24h, no Apple request */
      cached: boolean;
    }
);

export type State = { rows: Row[]; error?: string };

type Pair = { country: string; phrase: string; seed?: string };

const appIdField = z
  .string()
  .trim()
  .regex(/^(\d{1,15})?$/, "App ID must be a number")
  .transform((s) => (s ? Number(s) : null));

const input = z.object({
  phrases: phrasesField,
  countries: countriesField,
  appId: appIdField,
});

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toRow(
  country: string,
  phrase: string,
  check: {
    volume: number;
    difficulty: number;
    topApps: TopApp[];
    checkedAt: Date;
  },
  appId: number | null,
  cached: boolean,
): Row {
  const leader = check.topApps[0];
  return {
    country,
    phrase,
    rank: appId === null ? null : rankOf(check.topApps, appId),
    volume: check.volume,
    difficulty: check.difficulty,
    label: difficultyLabel(check.difficulty),
    leader: leader ? { name: leader.name, icon: leader.icon } : null,
    medianRatings: median(check.topApps.slice(0, 10).map((a) => a.ratings)),
    checkedAt: check.checkedAt.toISOString(),
    cached,
  };
}

export async function checkKeywords(
  _prev: State,
  formData: FormData,
): Promise<State> {
  const parsed = input.safeParse({
    phrases: String(formData.get("phrases") ?? ""),
    countries: String(formData.get("countries") ?? ""),
    appId: String(formData.get("appId") ?? ""),
  });
  if (!parsed.success) {
    return { rows: [], error: parsed.error.issues[0].message };
  }
  const { phrases, countries, appId } = parsed.data;

  const total = phrases.length * countries.length;
  if (total > MAX_CHECKS) {
    return {
      rows: [],
      error: `That is ${phrases.length} keyword${phrases.length === 1 ? "" : "s"} across ${countries.length} storefront${countries.length === 1 ? "" : "s"}, ${total} checks. Run at most ${MAX_CHECKS} at a time.`,
    };
  }

  return {
    rows: await runChecks(
      phrases.flatMap((phrase) =>
        countries.map((country) => ({ country, phrase })),
      ),
      appId,
    ),
  };
}

/** Check explicit storefront and phrase pairs, e.g. picked from AI ideas. */
export async function checkPairs(
  pairs: { country: string; phrase: string }[],
  appId: number | null,
): Promise<State> {
  const parsed = z
    .object({
      pairs: pairsField
        .min(1, "Select at least one keyword")
        .max(MAX_CHECKS, `Select at most ${MAX_CHECKS} keywords at a time`),
      appId: z.number().int().positive().nullable(),
    })
    .safeParse({ pairs, appId });
  if (!parsed.success) {
    return { rows: [], error: parsed.error.issues[0].message };
  }
  const unique = [
    ...new Map(
      parsed.data.pairs.map((p) => [`${p.country}:${p.phrase}`, p]),
    ).values(),
  ];
  return { rows: await runChecks(unique, parsed.data.appId) };
}

/** Check each pair in order, reusing checks from the last 24 hours. */
async function runChecks(pairs: Pair[], appId: number | null): Promise<Row[]> {
  const rows: Row[] = [];
  let throttled = false;
  let lastRequestAt = 0;

  // One pair at a time: Apple throttles, so never search in parallel
  for (const { country, phrase, seed } of pairs) {
    try {
      // Look the keyword up without inserting: an unknown storefront must not leave a row behind
      const [existing] = await db
        .select({ id: keywords.id })
        .from(keywords)
        .where(and(eq(keywords.country, country), eq(keywords.phrase, phrase)));

      const [latest] = existing
        ? await db
            .select()
            .from(keywordChecks)
            .where(eq(keywordChecks.keywordId, existing.id))
            .orderBy(desc(keywordChecks.checkedAt))
            .limit(1)
        : [];

      if (latest && Date.now() - latest.checkedAt.getTime() < CACHE_MS) {
        rows.push({ ...toRow(country, phrase, latest, appId, true), seed });
        continue;
      }

      if (throttled) {
        rows.push({
          country,
          phrase,
          seed,
          error:
            "Skipped, App Store search is rate limited. Try again in a minute.",
        });
        continue;
      }

      const wait = lastRequestAt + APPLE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      const check = await recordCheck(phrase, country, appId);
      rows.push({ ...toRow(country, phrase, check, appId, false), seed });
    } catch (e) {
      let error = "Check failed";
      if (e instanceof ThrottledError) {
        throttled = true;
        error = "App Store search is rate limited. Try again in a minute.";
      } else if (e instanceof InvalidStorefrontError) {
        error = `Unknown storefront ${country.toUpperCase()}`;
      } else if (e instanceof DOMException && e.name === "TimeoutError") {
        error = "App Store search timed out";
      } else {
        console.error(`runChecks ${country} "${phrase}"`, e);
      }
      rows.push({ country, phrase, seed, error });
    }
  }

  return rows;
}

const localizedSchema = z.object({
  results: z.array(
    z.object({
      seed: z.string().describe("The English seed phrase, exactly as given"),
      country: z.string().describe("Storefront code, exactly as given"),
      phrases: z
        .array(z.string())
        .describe("Native App Store search phrases, best first"),
    }),
  ),
});

/** Ask the model for native phrases per seed and storefront, then check them. */
export async function localizeKeywords(
  _prev: State,
  formData: FormData,
): Promise<State> {
  const parsed = input.safeParse({
    phrases: String(formData.get("phrases") ?? ""),
    countries: String(formData.get("countries") ?? ""),
    appId: String(formData.get("appId") ?? ""),
  });
  if (!parsed.success) {
    return { rows: [], error: parsed.error.issues[0].message };
  }
  const { phrases: seeds, countries, appId } = parsed.data;

  const combos = seeds.length * countries.length;
  if (combos > MAX_CHECKS) {
    return {
      rows: [],
      error: `That is ${combos} seed and storefront combinations. Each needs at least one check, so use at most ${MAX_CHECKS}.`,
    };
  }
  // Up to 3 phrases each, without going over the check cap
  const perCombo = Math.min(3, Math.floor(MAX_CHECKS / combos));

  let results: z.infer<typeof localizedSchema>["results"];
  try {
    const { output } = await generateText({
      model: MODEL,
      instructions:
        "You are an App Store keyword researcher. For each English seed phrase and storefront, write the phrases people in that storefront actually type into App Store search, in the storefront's primary language and script. Prefer natural local wording over literal translation. Lowercase, 1 to 4 words, no brand names, no duplicates.",
      prompt: `Seeds: ${seeds.map((s) => `"${s}"`).join(", ")}\nStorefronts: ${countries.join(", ")}\nReturn one entry per seed and storefront, with up to ${perCombo} phrases each, best first.`,
      output: Output.object({ schema: localizedSchema }),
      maxOutputTokens: 2000,
      timeout: 45_000,
    });
    results = output.results;
  } catch (e) {
    console.error("localizeKeywords", e);
    return { rows: [], error: describeAiError(e) };
  }

  // Keep only requested seeds and storefronts, normalised, deduplicated, capped
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const r of results) {
    const seed = normalize(r.seed);
    const country = r.country.trim().toLowerCase();
    if (!seeds.includes(seed) || !countries.includes(country)) continue;
    let taken = 0;
    for (const raw of r.phrases) {
      const phrase = normalize(raw);
      const key = `${country}:${phrase}`;
      if (!phrase || phrase.length > 100 || seen.has(key)) continue;
      if (taken === perCombo || pairs.length === MAX_CHECKS) break;
      seen.add(key);
      pairs.push({ country, phrase, seed });
      taken++;
    }
  }
  if (pairs.length === 0) {
    return { rows: [], error: "The AI returned no usable phrases. Try again." };
  }

  return { rows: await runChecks(pairs, appId) };
}
