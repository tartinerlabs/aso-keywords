"use server";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { keywordChecks, keywords, type TopApp } from "@/db/schema";
import {
  APPLE_GAP_MS,
  countriesField,
  phrasesField,
  recordCheck,
  sleep,
} from "@/lib/checks";
import { InvalidStorefrontError, ThrottledError } from "@/lib/itunes";
import { difficultyLabel, rankOf } from "@/lib/scoring";

const MAX_CHECKS = 15;
const CACHE_MS = 24 * 60 * 60 * 1000;

export type Row = { country: string; phrase: string } & (
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

const input = z.object({
  phrases: phrasesField,
  countries: countriesField,
  appId: z
    .string()
    .trim()
    .regex(/^(\d{1,15})?$/, "App ID must be a number")
    .transform((s) => (s ? Number(s) : null)),
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

  const rows: Row[] = [];
  let throttled = false;
  let lastRequestAt = 0;

  // One pair at a time: Apple throttles, so never search in parallel
  for (const phrase of phrases) {
    for (const country of countries) {
      try {
        // Look the keyword up without inserting: an unknown storefront must not leave a row behind
        const [existing] = await db
          .select({ id: keywords.id })
          .from(keywords)
          .where(
            and(eq(keywords.country, country), eq(keywords.phrase, phrase)),
          );

        const [latest] = existing
          ? await db
              .select()
              .from(keywordChecks)
              .where(eq(keywordChecks.keywordId, existing.id))
              .orderBy(desc(keywordChecks.checkedAt))
              .limit(1)
          : [];

        if (latest && Date.now() - latest.checkedAt.getTime() < CACHE_MS) {
          rows.push(toRow(country, phrase, latest, appId, true));
          continue;
        }

        if (throttled) {
          rows.push({
            country,
            phrase,
            error:
              "Skipped, App Store search is rate limited. Try again in a minute.",
          });
          continue;
        }

        const wait = lastRequestAt + APPLE_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();

        const check = await recordCheck(phrase, country, appId);
        rows.push(toRow(country, phrase, check, appId, false));
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
          console.error(`checkKeywords ${country} "${phrase}"`, e);
        }
        rows.push({ country, phrase, error });
      }
    }
  }

  return { rows };
}
