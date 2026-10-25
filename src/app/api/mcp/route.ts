import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { checkKeywords } from "@/app/actions";
import { suggestKeywords } from "@/app/ideas/actions";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { loadTracked } from "@/lib/checks";
import { rankOf } from "@/lib/scoring";

// keyword_check runs up to 15 Apple searches in sequence, 3.5s apart
export const maxDuration = 120;

const json = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  isError,
});

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "keyword_check",
      {
        title: "Check keywords",
        description:
          "Score App Store search phrases per storefront: volume and difficulty (0-100), plus the app's placement when appId is given. At most 15 phrase x storefront checks per call; checks from the last 24h are reused, new ones take about 3.5s each.",
        inputSchema: z.object({
          phrases: z.array(z.string()).min(1).describe("Search phrases"),
          storefronts: z
            .array(z.string())
            .min(1)
            .describe("Two-letter storefront codes, e.g. us, de, jp"),
          appId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Numeric App Store ID to get placement for"),
        }),
      },
      async ({ phrases, storefronts, appId }) => {
        const state = await checkKeywords(
          { rows: [] },
          form({
            phrases: phrases.join("\n"),
            countries: storefronts.join(" "),
            appId: appId === undefined ? "" : String(appId),
          }),
        );
        return state.error ? json({ error: state.error }, true) : json(state);
      },
    );

    server.registerTool(
      "tracked_rankings",
      {
        title: "Tracked rankings",
        description:
          "Latest placement, volume and difficulty for each keyword tracked for one of your apps, with the change since the previous check. Placement null means not in the first 200 results.",
        inputSchema: z.object({
          appId: z.number().int().positive().describe("Numeric App Store ID"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ appId }) => {
        const [app] = await db
          .select({ name: apps.name })
          .from(apps)
          .where(and(eq(apps.trackId, appId), eq(apps.isMine, true)));
        if (!app) {
          return json({ error: `App ${appId} is not one of your apps` }, true);
        }
        const keywords = (await loadTracked(appId)).map((t) => {
          const [latest, prev] = t.checks;
          return {
            phrase: t.phrase,
            storefront: t.country,
            rank: latest ? rankOf(latest.results, appId) : null,
            previousRank: prev ? rankOf(prev.results, appId) : null,
            volume: latest?.volume ?? null,
            volumeChange: latest && prev ? latest.volume - prev.volume : null,
            difficulty: latest?.difficulty ?? null,
            difficultyChange:
              latest && prev ? latest.difficulty - prev.difficulty : null,
            checkedAt: latest?.checkedAt.toISOString() ?? null,
          };
        });
        return json({ app: app.name, keywords });
      },
    );

    server.registerTool(
      "suggest_keywords",
      {
        title: "Suggest keywords",
        description:
          "AI keyword ideas for an app description, in each storefront's language (15 for one storefront, 10 each for up to 5). Ideas are not checked; pass them to keyword_check.",
        inputSchema: z.object({
          description: z
            .string()
            .describe("What the app does, 20 to 4000 characters"),
          storefronts: z
            .array(z.string())
            .min(1)
            .describe("Two-letter storefront codes, at most 5"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ description, storefronts }) => {
        const state = await suggestKeywords(
          { ideas: [] },
          form({ description, countries: storefronts.join(" ") }),
        );
        return state.error ? json({ error: state.error }, true) : json(state);
      },
    );
  },
  { serverInfo: { name: "aso-keywords", version: "0.1.0" } },
);

/** Accept only the MCP_TOKEN bearer; reject everything when it is unset. */
function verifyToken(_req: Request, bearerToken?: string) {
  const expected = process.env.MCP_TOKEN;
  if (!expected || !bearerToken) return undefined;
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { token: bearerToken, clientId: "owner", scopes: [] };
}

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST };
