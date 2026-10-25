import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { keywordChecks, keywords } from "@/db/schema";
import { InvalidStorefrontError, search, ThrottledError } from "@/lib/itunes";
import { difficultyScore, normalize, rankOf, volumeScore } from "@/lib/scoring";

// Gap between Apple requests, to stay under their rate limit
export const APPLE_GAP_MS = 3500;
const MAX_PHRASE_LENGTH = 100;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phrases split on newlines or commas, normalised and deduplicated. */
export const phrasesField = z
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
  );

/** Storefront codes split on spaces or commas, lowercased and deduplicated. */
export const countriesField = z
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
      .array(z.string().regex(/^[a-z]{2}$/, "Storefront codes are two letters"))
      .min(1, "Enter at least one storefront"),
  );

/** Search Apple once, score the results, then save the keyword and a new check. */
export async function recordCheck(
  phrase: string,
  country: string,
  appId: number | null,
) {
  const topApps = await search(phrase, country);
  const volume = volumeScore(phrase, topApps);
  const difficulty = difficultyScore(phrase, topApps);
  const rank = appId === null ? null : rankOf(topApps, appId);

  const [{ id: keywordId }] = await db
    .insert(keywords)
    // No-op update so RETURNING gives the id of an existing row too
    .values({ phrase, country })
    .onConflictDoUpdate({
      target: [keywords.country, keywords.phrase],
      set: { phrase: sql`excluded.phrase` },
    })
    .returning({ id: keywords.id });

  const [inserted] = await db
    .insert(keywordChecks)
    .values({ keywordId, volume, difficulty, topApps, appId, rank })
    .returning({ checkedAt: keywordChecks.checkedAt });

  return { volume, difficulty, topApps, rank, checkedAt: inserted.checkedAt };
}

/**
 * Check tracked keywords with no check in the last 20 hours, stalest first,
 * one at a time with a gap between Apple requests. Stops at the limit, at the
 * deadline or when Apple throttles; the next run picks up the rest.
 * Pass appId to refresh only that app's keywords.
 */
export async function refreshTracked({
  appId,
  limit,
  deadline,
}: {
  appId?: number;
  limit: number;
  deadline: number;
}) {
  const { rows: due } = await db.execute<{
    phrase: string;
    country: string;
    my_app: string | null;
  }>(sql`
    select k.phrase, k.country,
      ${
        appId === undefined
          ? sql`(select min(a.track_id) from app_keywords ak
              join apps a on a.track_id = ak.app_id
              where ak.keyword_id = k.id and a.is_mine)`
          : sql`${appId}::bigint`
      } as my_app
    from keywords k
    where exists (
        select 1 from app_keywords ak where ak.keyword_id = k.id
        ${appId === undefined ? sql`` : sql`and ak.app_id = ${appId}`}
      )
      and not exists (
        select 1 from keyword_checks c
        where c.keyword_id = k.id and c.checked_at > now() - interval '20 hours'
      )
    order by (select max(c.checked_at) from keyword_checks c where c.keyword_id = k.id) asc nulls first
    limit ${limit}`);

  let checked = 0;
  let failed = 0;
  let throttled = false;
  let lastRequestAt = 0;

  for (const { phrase, country, my_app } of due) {
    if (Date.now() + APPLE_GAP_MS > deadline) break;
    const wait = lastRequestAt + APPLE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      await recordCheck(
        phrase,
        country,
        my_app === null ? null : Number(my_app),
      );
      checked++;
    } catch (e) {
      if (e instanceof ThrottledError) {
        throttled = true;
        break;
      }
      failed++;
      if (
        !(e instanceof InvalidStorefrontError) &&
        !(e instanceof DOMException && e.name === "TimeoutError")
      ) {
        console.error(`refreshTracked ${country} "${phrase}"`, e);
      }
    }
  }

  return { due: due.length, checked, failed, throttled };
}
