"use client";

import { useActionState, useState } from "react";
import {
  addApp,
  addCompetitor,
  addKeywords,
  type FormState,
  refreshApp,
} from "./actions";

const fieldClass =
  "w-full rounded-control text-base sm:text-sm border border-input bg-card px-2.5 py-1.5 outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring";
const labelClass = "mb-1 block text-xs font-medium";
const buttonClass =
  "min-h-10 shrink-0 rounded-control bg-primary px-4 font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-8";
const secondaryClass =
  "min-h-10 shrink-0 rounded-control border border-border bg-card px-4 font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-8";

function Result({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-2 text-xs text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <output className="mt-2 block text-xs text-muted-foreground">
        {state.message}
      </output>
    );
  }
  return null;
}

/** Numeric App Store ID field with one button, for apps and competitors. */
function IdForm({
  action,
  name,
  label,
  button,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  name: string;
  label: string;
  button: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction}>
      <label htmlFor={name} className={labelClass}>
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={name}
          name={name}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="App ID, e.g. 341232718"
          className={`${fieldClass} font-mono`}
        />
        <button type="submit" disabled={pending} className={secondaryClass}>
          {pending ? "Adding…" : button}
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function AddAppForm() {
  return (
    <IdForm
      action={addApp}
      name="appId"
      label="Add your app"
      button="Add app"
    />
  );
}

export function AddCompetitorForm({ appId }: { appId: number }) {
  return (
    <IdForm
      action={addCompetitor.bind(null, appId)}
      name="competitorId"
      label="Compare with"
      button="Add"
    />
  );
}

export function AddKeywordsForm({ appId }: { appId: number }) {
  const [phrases, setPhrases] = useState("");
  const [countries, setCountries] = useState("us");
  // Controlled fields keep their values when React resets the form; clear phrases only once added
  const [state, formAction, pending] = useActionState(
    async (prev: FormState, formData: FormData) => {
      const next = await addKeywords(appId, prev, formData);
      if (!next.error) setPhrases("");
      return next;
    },
    {},
  );
  return (
    <form action={formAction}>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <div>
          <label htmlFor="track-phrases" className={labelClass}>
            Phrases to track
          </label>
          <textarea
            id="track-phrases"
            name="phrases"
            rows={2}
            value={phrases}
            onChange={(e) => setPhrases(e.target.value)}
            placeholder={"calorie counter\nfood diary"}
            className={`${fieldClass} resize-y`}
          />
        </div>
        <div>
          <label htmlFor="track-countries" className={labelClass}>
            Storefronts
          </label>
          <input
            id="track-countries"
            name="countries"
            type="text"
            value={countries}
            onChange={(e) => setCountries(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="us gb de"
            className={`${fieldClass} font-mono uppercase placeholder:normal-case`}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Adding…" : "Track"}
        </button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" name="localize" className="accent-primary" />
        Translate for each storefront (AI writes one local phrase per
        storefront, grouped under your English phrase)
      </label>
      <Result state={state} />
    </form>
  );
}

export function RefreshForm({ appId }: { appId: number }) {
  const [state, formAction, pending] = useActionState(
    refreshApp.bind(null, appId),
    {},
  );
  return (
    <form action={formAction} className="flex flex-col items-end">
      <button type="submit" disabled={pending} className={secondaryClass}>
        {pending ? "Refreshing…" : "Refresh now"}
      </button>
      {pending ? (
        <output className="mt-2 block text-xs text-muted-foreground">
          About 4 seconds per keyword, up to 15.
        </output>
      ) : (
        <Result state={state} />
      )}
    </form>
  );
}
