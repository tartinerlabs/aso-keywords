"use server";

import { generateText, Output } from "ai";
import { z } from "zod";
import { describeAiError, MODEL } from "@/lib/ai";
import { countriesField } from "@/lib/checks";
import { normalize } from "@/lib/scoring";

const MAX_STOREFRONTS = 5;
const MAX_DESCRIPTION = 4000;

export type Idea = { country: string; phrase: string };
export type IdeasState = { ideas: Idea[]; error?: string };

const input = z.object({
  description: z
    .string()
    .trim()
    .min(20, "Describe the app in a sentence or two")
    .max(
      MAX_DESCRIPTION,
      `Keep the description under ${MAX_DESCRIPTION} characters`,
    ),
  countries: countriesField.pipe(
    z
      .array(z.string())
      .max(MAX_STOREFRONTS, `Pick at most ${MAX_STOREFRONTS} storefronts`),
  ),
});

const ideasSchema = z.object({
  results: z.array(
    z.object({
      country: z.string().describe("Storefront code, exactly as given"),
      keywords: z
        .array(z.string())
        .describe("App Store search phrases, most relevant first"),
    }),
  ),
});

/** Ask the model for candidate keywords per storefront from an app description. */
export async function suggestKeywords(
  _prev: IdeasState,
  formData: FormData,
): Promise<IdeasState> {
  const parsed = input.safeParse({
    description: String(formData.get("description") ?? ""),
    countries: String(formData.get("countries") ?? ""),
  });
  if (!parsed.success) {
    return { ideas: [], error: parsed.error.issues[0].message };
  }
  const { description, countries } = parsed.data;
  const perCountry = countries.length === 1 ? 15 : 10;

  let results: z.infer<typeof ideasSchema>["results"];
  try {
    const { output } = await generateText({
      model: MODEL,
      instructions:
        'You are an App Store keyword researcher. Suggest short phrases people really type into App Store search to find an app like the one described: its core function, use cases, problems solved and synonyms. Write each storefront\'s phrases in its primary language and script. Lowercase, 1 to 3 words. No brand or competitor names, no filler like "app" or "free", no duplicates.',
      prompt: `Storefronts: ${countries.join(", ")}\nReturn one entry per storefront with ${perCountry} keywords each.\n\nApp description:\n${description}`,
      output: Output.object({ schema: ideasSchema }),
      maxOutputTokens: 2000,
      timeout: 45_000,
    });
    results = output.results;
  } catch (e) {
    console.error("suggestKeywords", e);
    return { ideas: [], error: describeAiError(e) };
  }

  // Keep only requested storefronts, normalised, deduplicated, capped
  const seen = new Set<string>();
  const ideas: Idea[] = [];
  for (const r of results) {
    const country = r.country.trim().toLowerCase();
    if (!countries.includes(country)) continue;
    let taken = 0;
    for (const raw of r.keywords) {
      const phrase = normalize(raw);
      const key = `${country}:${phrase}`;
      if (!phrase || phrase.length > 100 || seen.has(key)) continue;
      if (taken === perCountry) break;
      seen.add(key);
      ideas.push({ country, phrase });
      taken++;
    }
  }
  if (ideas.length === 0) {
    return {
      ideas: [],
      error: "The AI returned no usable keywords. Try again.",
    };
  }
  // Group by storefront in the order the user typed them
  ideas.sort(
    (a, b) => countries.indexOf(a.country) - countries.indexOf(b.country),
  );
  return { ideas };
}
