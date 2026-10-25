"use server";

import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { keywordChecks, keywords, type TopApp } from "@/db/schema";
import { search, ThrottledError } from "@/lib/itunes";
import {
  difficultyLabel,
  difficultyScore,
  normalize,
  rankOf,
  volumeScore,
} from "@/lib/scoring";

const MAX_CHECKS = 15;
const MAX_PHRASE_LENGTH = 100;
const CACHE_MS = 24 * 60 * 60 * 1000;
// Gap between Apple requests, to stay under their rate limit
const APPLE_GAP_MS = 3500;

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
  phrases: z
    .string()
    .transform((s) => [
      ...new Set(s.split(/[\n,]/).map(normalize).filter(Boolean)),
    ])
    .pipe(
      z
        .array(
          z
            .string()
            .max(
              MAX_PHRASE_LENGTH,
              `Keep keywords under ${MAX_PHRASE_LENGTH} characters`,
            ),
        )
        .min(1, "Enter at least one keyword"),
    ),
  countries: z
    .string()
    .transform((s) => [
      ...new Set(
        s
          .toLowerCase()
          .split(/[\s,]+/)
          .filter(Boolean),
      ),
    ])
    .pipe(
      z
        .array(
          z.string().regex(/^[a-z]{2}$/, "Storefront codes are two letters"),
        )
        .min(1, "Enter at least one storefront"),
    ),
  appId: z
    .string()
    .trim()
    .regex(/^(\d{1,15})?$/, "App ID must be a number")
    .transform((s) => (s ? Number(s) : null)),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        const [{ id: keywordId }] = await db
          .insert(keywords)
          // No-op update so RETURNING gives the id of an existing row too
          .values({ phrase, country })
          .onConflictDoUpdate({
            target: [keywords.country, keywords.phrase],
            set: { phrase: sql`excluded.phrase` },
          })
          .returning({ id: keywords.id });

        const [latest] = await db
          .select()
          .from(keywordChecks)
          .where(eq(keywordChecks.keywordId, keywordId))
          .orderBy(desc(keywordChecks.checkedAt))
          .limit(1);

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

        const topApps = await search(phrase, country);
        const volume = volumeScore(phrase, topApps);
        const difficulty = difficultyScore(phrase, topApps);
        const rank = appId === null ? null : rankOf(topApps, appId);

        const [inserted] = await db
          .insert(keywordChecks)
          .values({ keywordId, volume, difficulty, topApps, appId, rank })
          .returning({ checkedAt: keywordChecks.checkedAt });

        rows.push(
          toRow(
            country,
            phrase,
            { volume, difficulty, topApps, checkedAt: inserted.checkedAt },
            appId,
            false,
          ),
        );
      } catch (e) {
        let error = "Check failed";
        if (e instanceof ThrottledError) {
          throttled = true;
          error = "App Store search is rate limited. Try again in a minute.";
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
