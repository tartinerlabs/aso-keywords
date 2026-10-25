import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { db } from "@/db";
import { appCompetitors, apps } from "@/db/schema";
import { HISTORY, loadTracked } from "@/lib/checks";
import { rankOf } from "@/lib/scoring";
import { removeCompetitor, removeKeyword } from "./actions";
import {
  AddAppForm,
  AddCompetitorForm,
  AddKeywordsForm,
  RefreshForm,
} from "./forms";

export const metadata: Metadata = { title: "Tracking" };

// Manual refresh runs up to 15 Apple searches in sequence
export const maxDuration = 120;

const headClass =
  "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground";
const cellClass = "px-2 py-1.5 align-middle";
const sectionHeadClass =
  "mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground";

type App = { trackId: number; name: string; icon: string };

export default function TrackingPage(props: PageProps<"/tracking">) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="text-lg font-semibold tracking-tight">Tracking</h1>
      <p className="mt-1 mb-6 text-muted-foreground">
        Your apps&apos; keywords, checked once a day, and the competitors that
        place above you.
      </p>
      <Suspense
        fallback={
          <div className="h-40 animate-pulse rounded-card border border-border bg-card" />
        }
      >
        <Tracking searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

function Icon({ app, size = 16 }: { app: Pick<App, "icon">; size?: number }) {
  return (
    // biome-ignore lint/performance/noImgElement: tiny remote icon, no optimisation needed
    <img
      src={app.icon}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[4px]"
      style={{ width: size, height: size }}
    />
  );
}

async function Tracking({
  searchParams,
}: Pick<PageProps<"/tracking">, "searchParams">) {
  const { app: selectedId } = await searchParams;
  const mine = await db
    .select({ trackId: apps.trackId, name: apps.name, icon: apps.icon })
    .from(apps)
    .where(eq(apps.isMine, true))
    .orderBy(asc(apps.createdAt));
  const selected =
    mine.find((a) => String(a.trackId) === selectedId) ?? mine[0];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        {mine.length > 0 && (
          <nav aria-label="Your apps" className="flex flex-wrap gap-2">
            {mine.map((a) => {
              const current = a.trackId === selected?.trackId;
              return (
                <Link
                  key={a.trackId}
                  href={`/tracking?app=${a.trackId}`}
                  aria-current={current ? "page" : undefined}
                  className={`flex min-h-8 items-center gap-2 rounded-control border px-2.5 ${current ? "border-primary bg-card font-medium" : "border-border hover:bg-muted"}`}
                >
                  <Icon app={a} />
                  <span className="max-w-48 truncate">{a.name}</span>
                </Link>
              );
            })}
          </nav>
        )}
        <div className="w-full sm:w-80">
          <AddAppForm />
        </div>
      </div>

      {selected ? (
        <AppDetail app={selected} />
      ) : (
        <div className="rounded-card border border-dashed border-border px-4 py-10 text-center">
          <p className="font-medium">No apps yet.</p>
          <p className="mt-1 text-muted-foreground">
            Add your app by its numeric App Store ID to start tracking keywords.
          </p>
        </div>
      )}
    </>
  );
}

function Placement({ rank }: { rank: number | null }) {
  if (rank === null) {
    return (
      <span
        role="img"
        aria-label="Not in the first 200 results"
        title="Not in the first 200 results"
        className="text-muted-foreground"
      >
        –
      </span>
    );
  }
  const tone =
    rank <= 10
      ? "font-semibold text-rank-top"
      : rank <= 50
        ? "text-rank-mid"
        : "text-rank-low";
  return <span className={`font-mono ${tone}`}>{rank}</span>;
}

/** Places moved since the previous check: up is good. */
function RankChange({
  rank,
  prev,
}: {
  rank: number | null;
  prev: number | null | undefined;
}) {
  if (prev === undefined || rank === prev) return null;
  const base = "ml-1.5 font-mono text-[11px]";
  if (prev === null) return <span className={`${base} text-primary`}>new</span>;
  if (rank === null) {
    return <span className={`${base} text-muted-foreground`}>dropped</span>;
  }
  const moved = prev - rank;
  return moved > 0 ? (
    <span
      className={`${base} text-primary`}
      title={`Up ${moved} since the previous check`}
    >
      ↑{moved}
    </span>
  ) : (
    <span
      className={`${base} text-muted-foreground`}
      title={`Down ${-moved} since the previous check`}
    >
      ↓{-moved}
    </span>
  );
}

function Delta({ value, prev }: { value: number; prev: number | undefined }) {
  if (prev === undefined || value === prev) return null;
  const d = value - prev;
  return (
    <span className="ml-1 font-mono text-[11px] text-muted-foreground">
      {d > 0 ? `+${d}` : `−${-d}`}
    </span>
  );
}

/** Rank over time, oldest to newest, on a log scale; gaps where unranked. */
function Sparkline({ ranks }: { ranks: (number | null)[] }) {
  const w = 72;
  const h = 20;
  if (ranks.length < 2) {
    return <span className="text-muted-foreground">–</span>;
  }
  const step = w / (ranks.length - 1);
  const y = (r: number) => 2 + (Math.log(r) / Math.log(200)) * (h - 4);
  let d = "";
  let open = false;
  ranks.forEach((r, i) => {
    if (r === null) {
      open = false;
      return;
    }
    d += `${open ? "L" : "M"}${(i * step).toFixed(1)} ${y(r).toFixed(1)}`;
    open = true;
  });
  const last = ranks[ranks.length - 1];
  const ranked = ranks.filter((r) => r !== null);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={
        ranked.length
          ? `Rank over the last ${ranks.length} checks, best ${Math.min(...ranked)}`
          : `Not ranked in the last ${ranks.length} checks`
      }
      className="overflow-visible text-muted-foreground"
    >
      <line
        x1={0}
        x2={w}
        y1={y(10)}
        y2={y(10)}
        stroke="var(--border)"
        strokeDasharray="2 2"
      />
      {d && (
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {last !== null && (
        <circle cx={w} cy={y(last)} r={2} fill="var(--primary)" />
      )}
    </svg>
  );
}

const when = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

async function AppDetail({ app }: { app: App }) {
  const [tracked, competitors] = await Promise.all([
    loadTracked(app.trackId),
    db
      .select({ trackId: apps.trackId, name: apps.name, icon: apps.icon })
      .from(appCompetitors)
      .innerJoin(apps, eq(apps.trackId, appCompetitors.competitorId))
      .where(eq(appCompetitors.appId, app.trackId))
      .orderBy(asc(apps.name)),
  ]);

  const rows = tracked.map((t) => {
    const [latest, prev] = t.checks;
    const rank = latest ? rankOf(latest.results, app.trackId) : null;
    // Competitors placing above me on the latest check, best first
    const above = latest
      ? competitors
          .map((c) => ({ ...c, rank: rankOf(latest.results, c.trackId) }))
          .filter(
            (c): c is typeof c & { rank: number } =>
              c.rank !== null && (rank === null || c.rank < rank),
          )
          .sort((a, b) => a.rank - b.rank)
      : [];
    return {
      ...t,
      latest,
      prev,
      rank,
      prevRank: prev ? rankOf(prev.results, app.trackId) : undefined,
      history: t.checks.map((c) => rankOf(c.results, app.trackId)).reverse(),
      above,
    };
  });
  const checkedCount = rows.filter((r) => r.latest).length;

  return (
    <div className="grid gap-6">
      <section className="rounded-card border border-border bg-card p-4 shadow-[0_1px_0_var(--border)]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Icon app={app} size={40} />
            <div>
              <h2 className="font-semibold">{app.name}</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {app.trackId}
              </p>
            </div>
          </div>
          <RefreshForm appId={app.trackId} />
        </div>
        <AddKeywordsForm appId={app.trackId} />
      </section>

      <section>
        <h3 className={sectionHeadClass}>
          Keywords{" "}
          {rows.length > 0 && (
            <span className="normal-case tracking-normal">
              · {rows.length} tracked, {checkedCount} checked
            </span>
          )}
        </h3>
        {rows.length === 0 ? (
          <div className="rounded-card border border-dashed border-border px-4 py-10 text-center">
            <p className="font-medium">No keywords tracked.</p>
            <p className="mt-1 text-muted-foreground">
              Add phrases and storefronts above. They are checked once a day, or
              now with Refresh.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border bg-card">
            <table className="w-full min-w-[52rem] border-collapse text-[13px] tabular-nums">
              <thead>
                <tr>
                  <th scope="col" className={headClass}>
                    Phrase
                  </th>
                  <th scope="col" className={headClass}>
                    Store
                  </th>
                  <th scope="col" className={headClass}>
                    Placement
                  </th>
                  <th
                    scope="col"
                    className={headClass}
                    title={`Placement over the last ${HISTORY} checks; dashed line is 10th place`}
                  >
                    Trend
                  </th>
                  <th
                    scope="col"
                    className={headClass}
                    title="How hard the top 50 apps target this phrase. Not Apple search popularity."
                  >
                    Volume
                  </th>
                  <th
                    scope="col"
                    className={headClass}
                    title="Competition, from rating counts of the top 10 apps."
                  >
                    Difficulty
                  </th>
                  <th
                    scope="col"
                    className={headClass}
                    title="Competitors placing above your app on the latest check"
                  >
                    Above you
                  </th>
                  <th scope="col" className={headClass}>
                    Checked (UTC)
                  </th>
                  <th scope="col" className={headClass}>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.keywordId}
                    className="border-t border-border hover:bg-muted"
                  >
                    <td className={`${cellClass} font-medium`}>{r.phrase}</td>
                    <td className={`${cellClass} font-mono uppercase`}>
                      {r.country}
                    </td>
                    {r.latest ? (
                      <>
                        <td className={`${cellClass} whitespace-nowrap`}>
                          <Placement rank={r.rank} />
                          <RankChange rank={r.rank} prev={r.prevRank} />
                        </td>
                        <td className={cellClass}>
                          <Sparkline ranks={r.history} />
                        </td>
                        <td className={`${cellClass} font-mono`}>
                          {r.latest.volume}
                          <Delta
                            value={r.latest.volume}
                            prev={r.prev?.volume}
                          />
                        </td>
                        <td className={`${cellClass} font-mono`}>
                          {r.latest.difficulty}
                          <Delta
                            value={r.latest.difficulty}
                            prev={r.prev?.difficulty}
                          />
                        </td>
                        <td className={cellClass}>
                          {r.above.length === 0 ? (
                            <span className="text-muted-foreground">–</span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-2">
                              {r.above.map((c) => (
                                <span
                                  key={c.trackId}
                                  className="inline-flex items-center gap-1"
                                  title={`${c.name} places ${c.rank}`}
                                >
                                  <Icon app={c} />
                                  <span className="font-mono text-[11px]">
                                    {c.rank}
                                  </span>
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td
                          className={`${cellClass} whitespace-nowrap font-mono text-[11px] text-muted-foreground`}
                        >
                          {when.format(r.latest.checkedAt)}
                        </td>
                      </>
                    ) : (
                      <td
                        colSpan={6}
                        className={`${cellClass} text-muted-foreground`}
                      >
                        Not checked yet
                      </td>
                    )}
                    <td className={`${cellClass} text-right`}>
                      <form
                        action={removeKeyword.bind(
                          null,
                          app.trackId,
                          r.keywordId,
                        )}
                      >
                        <button
                          type="submit"
                          className="rounded-control px-1.5 text-xs text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Stop tracking ${r.phrase} in ${r.country.toUpperCase()}`}
                        >
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-[1fr_20rem]">
        <div>
          <h3 className={sectionHeadClass}>Competitors</h3>
          {competitors.length === 0 ? (
            <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-muted-foreground">
              Add competitors to see where they place above you.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border bg-card">
              {competitors.map((c) => {
                const ahead = rows.filter((r) =>
                  r.above.some((a) => a.trackId === c.trackId),
                ).length;
                return (
                  <li
                    key={c.trackId}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <Icon app={c} size={24} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {c.trackId}
                      </p>
                    </div>
                    <p className="text-xs whitespace-nowrap">
                      {checkedCount === 0 ? (
                        <span className="text-muted-foreground">
                          No checks yet
                        </span>
                      ) : (
                        <>
                          Outranks you on{" "}
                          <span className="font-mono font-semibold">
                            {ahead}
                          </span>{" "}
                          of {checkedCount}
                        </>
                      )}
                    </p>
                    <form
                      action={removeCompetitor.bind(
                        null,
                        app.trackId,
                        c.trackId,
                      )}
                    >
                      <button
                        type="submit"
                        className="rounded-control px-1.5 text-xs text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Stop comparing with ${c.name}`}
                      >
                        Remove
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="sm:pt-6">
          <AddCompetitorForm appId={app.trackId} />
        </div>
      </section>
    </div>
  );
}
