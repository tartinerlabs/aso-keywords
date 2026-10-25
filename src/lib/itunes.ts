import "server-only";

import type { TopApp } from "@/db/schema";

/** Apple throttled the request (403, 429 or a non-JSON body); wait and retry later. */
export class ThrottledError extends Error {
  constructor(message = "App Store search is rate limited") {
    super(message);
    this.name = "ThrottledError";
  }
}

/** App Store search results for a phrase in one storefront, in rank order. */
export async function search(
  phrase: string,
  country: string,
): Promise<TopApp[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(phrase)}&country=${country}&entity=software&limit=200`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (res.status === 403 || res.status === 429) throw new ThrottledError();
  // A 400 means the term was badly encoded: not retryable
  if (!res.ok) throw new Error(`App Store search failed (${res.status})`);

  let data: { results?: Record<string, unknown>[] };
  try {
    data = await res.json();
  } catch {
    throw new ThrottledError("App Store search returned a non-JSON response");
  }

  return (data.results ?? []).flatMap((r) =>
    typeof r.trackId === "number"
      ? [
          {
            id: r.trackId,
            name: (r.trackName as string) ?? "",
            icon: (r.artworkUrl100 as string) ?? "",
            ratings: (r.userRatingCount as number) ?? 0,
            avg: (r.averageUserRating as number) ?? 0,
          },
        ]
      : [],
  );
}
