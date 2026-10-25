import "server-only";

import { APICallError, NoObjectGeneratedError, RetryError } from "ai";

/** The one model every AI feature uses, routed through Vercel AI Gateway. */
export const MODEL = "anthropic/claude-sonnet-5.5";

/** A short, user-facing message for an AI SDK or AI Gateway failure. */
export function describeAiError(error: unknown): string {
  const e = RetryError.isInstance(error) ? error.lastError : error;
  const type = e instanceof Error && "type" in e ? e.type : undefined;
  const message = e instanceof Error ? e.message : "";

  if (type === "authentication_error") {
    return "AI Gateway credentials are missing or expired. Locally, run `vercel env pull` to refresh VERCEL_OIDC_TOKEN, or set AI_GATEWAY_API_KEY.";
  }
  if (/free tier/i.test(message)) {
    return "This AI model needs paid AI Gateway credits on the Vercel team.";
  }
  if (
    type === "rate_limit_exceeded" ||
    (APICallError.isInstance(e) && e.statusCode === 429)
  ) {
    return "AI rate limit hit. Try again in a minute.";
  }
  if (type === "model_not_found") return `AI model ${MODEL} is not available.`;
  if (NoObjectGeneratedError.isInstance(e)) {
    return "The AI returned an invalid result. Try again.";
  }
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return "The AI took too long. Try again.";
  }
  return "AI request failed.";
}
