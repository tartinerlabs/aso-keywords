"use server";

import { generateText, Output } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { describeAiError, MODEL } from "@/lib/ai";
import {
  AscError,
  ascConfig,
  KEYWORDS_MAX,
  type Listing,
  NAME_MAX,
  readListing,
  STOREFRONT_LOCALES,
  SUBTITLE_MAX,
  saveDraft,
} from "@/lib/asc";
import { lookup } from "@/lib/itunes";
import { normalize } from "@/lib/scoring";

const MAX_LOCALES = 5;
// Keywords per locale sent to the model, best first
const MAX_PROMPT_KEYWORDS = 40;

export type TrackedKeyword = {
  phrase: string;
  volume: number | null;
  difficulty: number | null;
  rank: number | null;
};

export type LocaleProposal = {
  country: string;
  locale: string;
  before: Listing;
  after: Listing;
  keywords: TrackedKeyword[];
};

export type ProposalState = {
  proposals: LocaleProposal[];
  /** Where "before" came from */
  source?: "asc" | "public";
  error?: string;
  warning?: string;
};

export type SaveState = { error?: string; message?: string };

const appIdField = z.number().int().positive();

async function isMine(appId: number) {
  const [row] = await db
    .select({ trackId: apps.trackId })
    .from(apps)
    .where(and(eq(apps.trackId, appId), eq(apps.isMine, true)));
  return Boolean(row);
}

/** Tracked keywords in the storefronts with their latest check, best value first. */
async function loadKeywords(appId: number, countries: string[]) {
  const { rows } = await db.execute<{
    country: string;
    phrase: string;
    volume: number | null;
    difficulty: number | null;
    rank: number | null;
  }>(sql`
    select k.country, k.phrase, c.volume, c.difficulty, c.rank
    from app_keywords ak
    join keywords k on k.id = ak.keyword_id
    left join lateral (
      select volume, difficulty,
        (select i::int from jsonb_array_elements(top_apps) with ordinality as t(app, i)
          where (app->>'id')::bigint = ${appId} limit 1) as rank
      from keyword_checks
      where keyword_id = k.id
      order by checked_at desc
      limit 1
    ) c on true
    where ak.app_id = ${appId}
      and k.country in (${sql.join(
        countries.map((c) => sql`${c}`),
        sql`, `,
      )})
    order by coalesce(c.volume, 0) - coalesce(c.difficulty, 100) / 2 desc, k.phrase`);
  const byCountry = new Map<string, TrackedKeyword[]>();
  for (const { country, ...k } of rows) {
    byCountry.set(country, [...(byCountry.get(country) ?? []), k]);
  }
  return byCountry;
}

/** Cut to max characters at a word boundary when possible, without dangling separators. */
function fit(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s\-–—:,|&+]+$/u, "");
}

/** Single words, comma-separated, no spaces, none already in the name or subtitle, at most 100 characters. */
function keywordField(raw: string, name: string, subtitle: string): string {
  const used = new Set(normalize(`${name} ${subtitle}`).split(" "));
  const out: string[] = [];
  let length = 0;
  for (const word of normalize(raw).split(" ")) {
    if (!word || used.has(word)) continue;
    const add = word.length + (out.length > 0 ? 1 : 0);
    if (length + add > KEYWORDS_MAX) continue; // a shorter word may still fit
    used.add(word);
    out.push(word);
    length += add;
  }
  return out.join(",");
}

const proposalSchema = z.object({
  listings: z.array(
    z.object({
      locale: z.string().describe("Locale code, exactly as given"),
      name: z.string(),
      subtitle: z.string(),
      keywords: z
        .string()
        .describe("Single words separated by commas, no spaces"),
    }),
  ),
});

/** Ask the model for a name, subtitle and keyword field per storefront, built from tracked keywords. */
export async function proposeListing(
  appId: number,
  countries: string[],
): Promise<ProposalState> {
  const parsed = z
    .object({
      appId: appIdField,
      countries: z
        .array(z.string().regex(/^[a-z]{2}$/))
        .min(1, "Pick at least one storefront")
        .max(MAX_LOCALES, `Pick at most ${MAX_LOCALES} storefronts`),
    })
    .safeParse({ appId, countries: [...new Set(countries)] });
  if (!parsed.success) {
    return { proposals: [], error: parsed.error.issues[0].message };
  }
  if (!(await isMine(appId))) {
    return { proposals: [], error: "Add this app on Tracking first" };
  }
  const picked = parsed.data.countries.map((country) => ({
    country,
    locale: STOREFRONT_LOCALES[country],
  }));
  const unsupported = picked.find((p) => !p.locale);
  if (unsupported) {
    return {
      proposals: [],
      error: `No App Store locale mapped for ${unsupported.country.toUpperCase()}`,
    };
  }
  const shared = picked.find(
    (p, i) => picked.findIndex((q) => q.locale === p.locale) !== i,
  );
  if (shared) {
    return {
      proposals: [],
      error: `Two storefronts use ${shared.locale}; pick one of them`,
    };
  }

  const tracked = await loadKeywords(appId, parsed.data.countries);
  const empty = picked.find((p) => !tracked.get(p.country)?.length);
  if (empty) {
    return {
      proposals: [],
      error: `No tracked keywords in ${empty.country.toUpperCase()}. Track some first.`,
    };
  }

  // Current listing: App Store Connect when connected, else the public name per storefront
  const current = new Map<string, Listing>();
  let source: ProposalState["source"] = "public";
  let warning: string | undefined;
  const config = ascConfig();
  if (config) {
    try {
      const listing = await readListing(config, appId);
      for (const p of picked) {
        current.set(
          p.locale,
          listing.locales[p.locale] ?? { name: "", subtitle: "", keywords: "" },
        );
      }
      source = "asc";
    } catch (e) {
      console.error("proposeListing readListing", e);
      warning = `Could not read App Store Connect (${e instanceof AscError ? e.message : "request failed"}); comparing against the public name only.`;
    }
  }
  if (source === "public") {
    for (const p of picked) {
      const found = await lookup(appId, p.country).catch(() => null);
      current.set(p.locale, {
        name: found?.name ?? "",
        subtitle: "",
        keywords: "",
      });
    }
  }

  const blocks = picked.map(({ country, locale }) => {
    const now = current.get(locale);
    const lines = (tracked.get(country) ?? [])
      .slice(0, MAX_PROMPT_KEYWORDS)
      .map(
        (k) =>
          `- ${k.phrase}: volume ${k.volume ?? "?"}, difficulty ${k.difficulty ?? "?"}, placement ${k.rank ?? "not in top 200"}`,
      );
    return `Locale ${locale} (storefront ${country})\nCurrent name: ${now?.name || "(none)"}\nCurrent subtitle: ${now?.subtitle || "(none)"}\nCurrent keyword field: ${now?.keywords || "(none)"}\nTracked keywords:\n${lines.join("\n")}`;
  });

  let listings: z.infer<typeof proposalSchema>["listings"];
  try {
    const { output } = await generateText({
      model: MODEL,
      instructions: `You are an App Store optimization copywriter. For each locale, write a new name, subtitle and keyword field in that locale's language, built from its tracked keywords. Volume (0-100) is how strongly the top 50 apps target a phrase in their names: an indirect sign of demand, not Apple search popularity. Difficulty (0-100): lower is easier to rank for. Favour high volume with low difficulty, and put the most valuable phrases in the name and subtitle, which weigh most. Keep the app's brand (the part of the current name before any dash or colon) at the start of the name. Name at most ${NAME_MAX} characters, subtitle at most ${SUBTITLE_MAX}, both natural and readable. Keyword field at most ${KEYWORDS_MAX} characters: single words separated by commas with no spaces, no word already used in the name or subtitle, no plural duplicates, no other apps' brand names.`,
      prompt: `Return one listing per locale.\n\n${blocks.join("\n\n")}`,
      output: Output.object({ schema: proposalSchema }),
      maxOutputTokens: 4000,
      timeout: 45_000,
    });
    listings = output.listings;
  } catch (e) {
    console.error("proposeListing", e);
    return { proposals: [], error: describeAiError(e) };
  }

  // Enforce Apple's limits in code; the model is only asked to respect them
  const skipped: string[] = [];
  const proposals = picked.map(({ country, locale }) => {
    const before = current.get(locale) ?? {
      name: "",
      subtitle: "",
      keywords: "",
    };
    const l = listings.find((x) => x.locale.trim() === locale);
    if (!l) skipped.push(locale);
    const name = l ? fit(l.name, NAME_MAX) : before.name;
    const subtitle = l ? fit(l.subtitle, SUBTITLE_MAX) : before.subtitle;
    return {
      country,
      locale,
      before,
      after: {
        name,
        subtitle,
        keywords: keywordField(l?.keywords ?? before.keywords, name, subtitle),
      },
      keywords: tracked.get(country) ?? [],
    };
  });
  if (skipped.length > 0) {
    warning = `The AI skipped ${skipped.join(", ")}; those show the current listing.`;
  }
  return { proposals, source, warning };
}

const draftsInput = z.object({
  appId: appIdField,
  confirmed: z.boolean().refine(Boolean, "Confirm before saving"),
  versionString: z
    .string()
    .trim()
    .regex(/^(\d+\.){0,2}\d+$/, "Version numbers look like 1.2.0")
    .or(z.literal("")),
  drafts: z
    .array(
      z.object({
        locale: z
          .string()
          .refine((l) => Object.values(STOREFRONT_LOCALES).includes(l)),
        name: z
          .string()
          .trim()
          .min(1, "Every locale needs a name")
          .max(NAME_MAX, `Names are at most ${NAME_MAX} characters`),
        subtitle: z
          .string()
          .trim()
          .max(
            SUBTITLE_MAX,
            `Subtitles are at most ${SUBTITLE_MAX} characters`,
          ),
        keywords: z
          .string()
          .trim()
          .max(
            KEYWORDS_MAX,
            `Keyword fields are at most ${KEYWORDS_MAX} characters`,
          )
          .regex(/^\S*$/, "Keyword fields cannot contain spaces"),
      }),
    )
    .min(1)
    .max(MAX_LOCALES),
});

/** Save the listing to a draft version in App Store Connect. Never submits for review. */
export async function saveListingDraft(
  input: z.input<typeof draftsInput>,
): Promise<SaveState> {
  const config = ascConfig();
  if (!config) return { error: "App Store Connect is not connected" };
  const parsed = draftsInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { appId, drafts, versionString } = parsed.data;
  if (!(await isMine(appId)))
    return { error: "Add this app on Tracking first" };

  try {
    const saved = await saveDraft(config, appId, drafts, versionString || null);
    // Re-render the page so the version state and current listing are fresh
    refresh();
    const where = saved.created
      ? `new version ${saved.versionString}`
      : `version ${saved.versionString}`;
    return {
      message: [
        `Saved ${drafts.length} locale${drafts.length === 1 ? "" : "s"} to ${where} as a draft. Nothing was submitted for review.`,
        ...saved.notes,
      ].join(" "),
    };
  } catch (e) {
    console.error("saveListingDraft", e);
    return {
      error: e instanceof AscError ? e.message : "App Store Connect failed",
    };
  }
}
