"use client";

import { startTransition, useActionState, useState } from "react";
import { isCovered } from "@/lib/scoring";
import {
  type LocaleProposal,
  type ProposalState,
  proposeListing,
  type SaveState,
  saveListingDraft,
  type TrackedKeyword,
} from "./actions";

const MAX_LOCALES = 5;
const LIMITS = { name: 30, subtitle: 30, keywords: 100 } as const;

const fieldClass =
  "w-full rounded-control text-base sm:text-sm border border-input bg-card px-2.5 py-1.5 outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring";
const labelClass = "mb-1 flex justify-between text-xs font-medium";
const buttonClass =
  "min-h-10 shrink-0 rounded-control bg-primary px-5 font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-8";
const sectionHeadClass =
  "mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground";

type Listing = LocaleProposal["after"];
type Field = keyof Listing;

/** Tracked keywords the listing covers, their summed volume and average difficulty. */
function coverage(keywords: TrackedKeyword[], l: Listing) {
  const text = `${l.name} ${l.subtitle} ${l.keywords}`;
  const covered = keywords.filter((k) => isCovered(k.phrase, text));
  const rated = covered.filter((k) => k.difficulty !== null);
  return {
    phrases: new Set(covered.map((k) => k.phrase)),
    volume: covered.reduce((sum, k) => sum + (k.volume ?? 0), 0),
    difficulty:
      rated.length > 0
        ? Math.round(
            rated.reduce((sum, k) => sum + (k.difficulty ?? 0), 0) /
              rated.length,
          )
        : null,
  };
}

function Change({
  before,
  after,
  higherIsBetter = true,
}: {
  before: number | null;
  after: number | null;
  higherIsBetter?: boolean;
}) {
  const better =
    before !== null &&
    after !== null &&
    (higherIsBetter ? after > before : after < before);
  return (
    <span className="font-mono">
      <span className="text-muted-foreground">{before ?? "–"}</span>
      {" → "}
      <span className={better ? "font-semibold text-primary" : ""}>
        {after ?? "–"}
      </span>
    </span>
  );
}

export function ListingForm({
  appId,
  storefronts,
  asc,
}: {
  appId: number;
  storefronts: { country: string; tracked: number; locale: string | null }[];
  asc: { configured: boolean; editableVersion: string | null };
}) {
  const supported = storefronts.filter((s) => s.locale !== null);
  const [countries, setCountries] = useState<Set<string>>(
    () =>
      new Set(
        supported
          .filter(
            (s, i) => supported.findIndex((t) => t.locale === s.locale) === i,
          )
          .slice(0, 1)
          .map((s) => s.country),
      ),
  );
  const [drafts, setDrafts] = useState<Listing[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [versionString, setVersionString] = useState("");

  const [proposal, proposeAction, proposing] = useActionState(
    async (_prev: ProposalState, picked: string[]) => {
      const next = await proposeListing(appId, picked);
      setDrafts(next.proposals.map((p) => p.after));
      setConfirmed(false);
      return next;
    },
    { proposals: [] },
  );
  const [saved, saveAction, saving] = useActionState(
    async (_prev: SaveState, _: null) => {
      const next = await saveListingDraft({
        appId,
        confirmed,
        versionString,
        drafts: proposal.proposals.map((p, i) => ({
          locale: p.locale,
          ...drafts[i],
        })),
      });
      if (!next.error) setConfirmed(false);
      return next;
    },
    {},
  );

  const toggle = (country: string) =>
    setCountries((prev) => {
      const next = new Set(prev);
      if (!next.delete(country)) next.add(country);
      return next;
    });
  const edit = (i: number, field: Field, value: string) =>
    setDrafts((prev) =>
      prev.map((d, j) => (j === i ? { ...d, [field]: value } : d)),
    );

  const stats = proposal.proposals.map((p, i) => ({
    before: coverage(p.keywords, p.before),
    after: coverage(p.keywords, drafts[i] ?? p.after),
  }));
  const total = (side: "before" | "after") => ({
    covered: stats.reduce((n, s) => n + s[side].phrases.size, 0),
    volume: stats.reduce((n, s) => n + s[side].volume, 0),
  });
  const tracked = proposal.proposals.reduce((n, p) => n + p.keywords.length, 0);
  const spaced = drafts.some((d) => /\s/.test(d.keywords));
  const needsVersion = asc.editableVersion === null;

  return (
    <>
      <section className="rounded-card border border-border bg-card p-4 shadow-[0_1px_0_var(--border)]">
        <fieldset>
          <legend className={sectionHeadClass}>Storefronts</legend>
          <div className="flex flex-wrap gap-2">
            {storefronts.map((s) => {
              const on = countries.has(s.country);
              return (
                <label
                  key={s.country}
                  className={`flex min-h-8 items-center gap-2 rounded-control border px-2.5 ${s.locale === null ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${on ? "border-primary bg-muted" : "border-border hover:bg-muted"}`}
                  title={
                    s.locale === null
                      ? "No App Store locale mapped for this storefront"
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={s.locale === null}
                    onChange={() => toggle(s.country)}
                    className="accent-primary"
                  />
                  <span className="font-mono uppercase">{s.country}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.locale ?? "unsupported"} · {s.tracked} tracked
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            AI writes a name, subtitle and keyword field per locale from your
            best tracked keywords. Up to {MAX_LOCALES} at once.
          </p>
          <button
            type="button"
            onClick={() => startTransition(() => proposeAction([...countries]))}
            disabled={
              proposing || countries.size === 0 || countries.size > MAX_LOCALES
            }
            className={buttonClass}
          >
            {proposing ? "Writing…" : "Propose listing"}
          </button>
        </div>
      </section>

      {proposal.error && (
        <p
          role="alert"
          className="mt-6 rounded-control border border-destructive px-3 py-2 text-destructive"
        >
          {proposal.error}
        </p>
      )}
      {proposal.warning && (
        <p className="mt-6 rounded-control bg-notice px-3 py-2 text-notice-foreground">
          {proposal.warning}
        </p>
      )}

      {proposal.proposals.length === 0 ? (
        !proposal.error && (
          <div className="mt-6 rounded-card border border-dashed border-border px-4 py-10 text-center">
            <p className="font-medium">No proposal yet.</p>
            <p className="mt-1 text-muted-foreground">
              Pick storefronts, then Propose listing.
            </p>
          </div>
        )
      ) : (
        <div aria-busy={proposing} className={proposing ? "opacity-60" : ""}>
          <section className="mt-6 grid gap-3 rounded-card border border-border bg-card p-4 sm:grid-cols-3">
            <div>
              <p className={sectionHeadClass}>Tracked keywords covered</p>
              <p className="text-lg">
                <Change
                  before={total("before").covered}
                  after={total("after").covered}
                />{" "}
                <span className="text-sm text-muted-foreground">
                  of {tracked}
                </span>
              </p>
            </div>
            <div>
              <p className={sectionHeadClass}>Summed volume</p>
              <p className="text-lg">
                <Change
                  before={total("before").volume}
                  after={total("after").volume}
                />
              </p>
            </div>
            <p className="text-xs text-muted-foreground sm:self-center">
              From stored checks; no new App Store searches.{" "}
              {proposal.source === "asc"
                ? "Now is your App Store Connect listing."
                : "Now is your public name only; connect App Store Connect to include subtitle and keyword field."}
            </p>
          </section>

          {proposal.proposals.map((p, i) => {
            const draft = drafts[i] ?? p.after;
            const s = stats[i];
            return (
              <section
                key={p.locale}
                className="mt-4 rounded-card border border-border bg-card p-4"
              >
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-medium">
                    <span className="font-mono uppercase">{p.country}</span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {p.locale}
                    </span>
                  </h2>
                  <p className="flex flex-wrap gap-x-4 text-xs">
                    <span>
                      Covers{" "}
                      <Change
                        before={s.before.phrases.size}
                        after={s.after.phrases.size}
                      />{" "}
                      of {p.keywords.length}
                    </span>
                    <span>
                      Volume{" "}
                      <Change before={s.before.volume} after={s.after.volume} />
                    </span>
                    <span>
                      Avg difficulty{" "}
                      <Change
                        before={s.before.difficulty}
                        after={s.after.difficulty}
                        higherIsBetter={false}
                      />
                    </span>
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {(["name", "subtitle"] as const).map((field) => (
                    <div key={field}>
                      <label
                        htmlFor={`${p.locale}-${field}`}
                        className={labelClass}
                      >
                        <span>{field === "name" ? "Name" : "Subtitle"}</span>
                        <span className="font-mono text-muted-foreground">
                          {draft[field].length} / {LIMITS[field]}
                        </span>
                      </label>
                      <input
                        id={`${p.locale}-${field}`}
                        type="text"
                        value={draft[field]}
                        maxLength={LIMITS[field]}
                        onChange={(e) => edit(i, field, e.target.value)}
                        className={fieldClass}
                      />
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        Now: {p.before[field] || "–"}
                      </p>
                    </div>
                  ))}
                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`${p.locale}-keywords`}
                      className={labelClass}
                    >
                      <span>Keyword field</span>
                      <span className="font-mono text-muted-foreground">
                        {draft.keywords.length} / {LIMITS.keywords}
                      </span>
                    </label>
                    <textarea
                      id={`${p.locale}-keywords`}
                      rows={2}
                      value={draft.keywords}
                      maxLength={LIMITS.keywords}
                      onChange={(e) => edit(i, "keywords", e.target.value)}
                      spellCheck={false}
                      className={`${fieldClass} resize-y font-mono`}
                    />
                    <p className="mt-1 text-xs break-all text-muted-foreground">
                      {/\s/.test(draft.keywords) ? (
                        <span className="text-destructive">
                          Separate words with commas only, no spaces.
                        </span>
                      ) : (
                        <>Now: {p.before.keywords || "–"}</>
                      )}
                    </p>
                  </div>
                </div>

                <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  {p.keywords.map((k) => {
                    const was = s.before.phrases.has(k.phrase);
                    const is = s.after.phrases.has(k.phrase);
                    const tone = is
                      ? was
                        ? "border-border bg-muted"
                        : "border-primary text-primary"
                      : was
                        ? "border-border text-muted-foreground line-through"
                        : "border-dashed border-border text-muted-foreground";
                    const label = is
                      ? was
                        ? "covered now and after"
                        : "newly covered"
                      : was
                        ? "no longer covered"
                        : "not covered";
                    return (
                      <li
                        key={k.phrase}
                        title={`${label} · volume ${k.volume ?? "?"} · difficulty ${k.difficulty ?? "?"}`}
                        className={`rounded-control border px-2 py-0.5 ${tone}`}
                      >
                        {is && !was && "+ "}
                        {k.phrase}
                        <span className="ml-1.5 font-mono opacity-70">
                          {k.volume ?? "–"}/{k.difficulty ?? "–"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          <section className="mt-4 rounded-card border border-border bg-card p-4">
            <h2 className={sectionHeadClass}>
              Save as draft in App Store Connect
            </h2>
            {asc.configured ? (
              <>
                <p className="text-muted-foreground">
                  {needsVersion
                    ? "No version is in Prepare for Submission, so saving creates one."
                    : `Saves to version ${asc.editableVersion}, which is in Prepare for Submission.`}{" "}
                  Name, subtitle and keyword field are written for{" "}
                  {proposal.proposals.map((p) => p.locale).join(", ")}. Nothing
                  is submitted for review.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {needsVersion && (
                    <div className="w-36">
                      <label htmlFor="version" className={labelClass}>
                        New version
                      </label>
                      <input
                        id="version"
                        type="text"
                        value={versionString}
                        onChange={(e) => setVersionString(e.target.value)}
                        placeholder="1.2.0"
                        autoComplete="off"
                        className={`${fieldClass} font-mono`}
                      />
                    </div>
                  )}
                  <label className="flex min-h-10 flex-1 cursor-pointer items-center gap-2 sm:min-h-8">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      className="accent-primary"
                    />
                    <span>
                      I reviewed these fields and want to overwrite the draft
                      metadata.
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => startTransition(() => saveAction(null))}
                    disabled={
                      saving ||
                      proposing ||
                      !confirmed ||
                      spaced ||
                      (needsVersion && versionString.trim() === "")
                    }
                    className={buttonClass}
                  >
                    {saving ? "Saving…" : "Save as draft"}
                  </button>
                </div>
                {saved.error && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {saved.error}
                  </p>
                )}
                {saved.message && (
                  <output className="mt-2 block text-xs text-muted-foreground">
                    {saved.message}
                  </output>
                )}
              </>
            ) : (
              <>
                <p className="text-muted-foreground">
                  Connect App Store Connect to save drafts. Create a team API
                  key with the App Manager role (Users and Access → Integrations
                  → App Store Connect API), then set these environment
                  variables:
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  <li>
                    <code className="font-mono">ASC_KEY_ID</code>: the key ID
                  </li>
                  <li>
                    <code className="font-mono">ASC_ISSUER_ID</code>: the issuer
                    ID shown above the keys
                  </li>
                  <li>
                    <code className="font-mono">ASC_PRIVATE_KEY</code>: the
                    downloaded .p8 file, base64-encoded (
                    <code className="font-mono">
                      base64 -i AuthKey_XXXX.p8 | tr -d &apos;\n&apos;
                    </code>
                    )
                  </li>
                </ul>
                <button
                  type="button"
                  disabled
                  className={`${buttonClass} mt-3`}
                >
                  Save as draft
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
