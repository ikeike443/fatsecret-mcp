import { after } from "next/server";

/**
 * Fire-and-forget security logging/alerting for auth-related failures on
 * this server (bad/missing MCP bearer token, invalid OAuth client_id or
 * client_secret, bad PKCE, disallowed redirect_uri).
 *
 * Two independent layers, so this degrades gracefully:
 *
 *  1. logSecurityEvent() ALWAYS runs and writes one line of structured JSON
 *     to stderr. On Vercel this lands in the function's logs with zero
 *     extra setup — no env var required. This is the floor: even if you
 *     never configure a webhook, failed auth attempts are not silently
 *     invisible.
 *  2. sendSecurityAlert() additionally POSTs the same event to
 *     SECURITY_ALERT_WEBHOOK_URL (a Slack or Discord "incoming webhook"
 *     URL) if that env var is set, so an attempted intrusion surfaces as a
 *     push notification instead of only being visible if/when someone
 *     happens to open the Vercel log viewer.
 *
 * Never include the actual secret value being checked (bearer token,
 * client_secret, code_verifier, etc.) in a logged/alerted event — only
 * metadata about the failed attempt (reason, IP, path, time). The whole
 * point of this module is to help detect a leak, so it must not itself
 * become a new place secrets can leak from (log aggregators, Slack
 * channels, etc. are not necessarily as tightly access-controlled as the
 * env vars themselves).
 */

export interface SecurityEvent {
  event: string;
  reason: string;
  ip: string;
  userAgent: string;
  path: string;
  time: string;
  [key: string]: unknown;
}

/**
 * Best-effort client IP extraction. Standard X-Forwarded-For semantics: each
 * proxy hop APPENDS the IP it saw the request come from, so the header reads
 * `client-supplied-value, ..., ip-as-seen-by-the-last-hop`. On Vercel,
 * Vercel's edge is the last hop before this app, so it appends the actual
 * connecting IP as the LAST entry — any earlier entry (including a fully
 * fabricated one) could have been set directly by the client. That makes the
 * LAST entry the most trustworthy one available to us; still treat this as
 * "best available signal for triage", not a security control in itself.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function buildSecurityEvent(
  req: Request,
  event: string,
  reason: string,
  extra: Record<string, unknown> = {}
): SecurityEvent {
  return {
    event,
    reason,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent") ?? "unknown",
    path: new URL(req.url).pathname,
    time: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Always logs, never throws. One line of JSON so a log viewer / log drain
 * can filter or alert on `event`/`reason`/`ip` directly instead of parsing
 * free text.
 */
export function logSecurityEvent(e: SecurityEvent): void {
  console.error(JSON.stringify(e));
}

/**
 * Schedules sendSecurityAlert() without making the caller await it.
 *
 * Prefers Next's `after()` so the webhook POST runs once the response has
 * already been sent — no added latency on the auth check, and (unlike a
 * bare un-awaited call) not at risk of being cut off mid-flight if the
 * serverless function is frozen right after responding.
 *
 * `after()` only works inside an active Next.js request scope (a Route
 * Handler, Server Action, or Middleware actually handling a request) — it
 * throws when called from anywhere else, e.g. a unit test that calls
 * verifyBearerToken()/this module directly instead of going through a real
 * HTTP request. That's caught here and falls back to a plain fire-and-forget
 * call, so this function is safe to call unconditionally from both
 * production route handlers and tests.
 */
export function scheduleSecurityAlert(e: SecurityEvent): void {
  try {
    after(() => sendSecurityAlert(e));
  } catch {
    void sendSecurityAlert(e);
  }
}

/**
 * Base SecurityEvent keys, used to find the caller-supplied "extra" fields
 * (clientId, redirectUri, responseType, grantType, ...) so they can be
 * summarized into the alert text below. These extra fields are always
 * non-secret request identifiers (client ids, redirect URIs, response
 * types) — never a presented token/secret value — so it's safe to render
 * them directly; this is not a place to spread arbitrary future fields
 * blindly, just these specific known-safe identifiers.
 */
const BASE_EVENT_KEYS = new Set([
  "event",
  "reason",
  "ip",
  "userAgent",
  "path",
  "time",
]);

function formatExtraFields(e: SecurityEvent): string {
  return Object.keys(e)
    .filter((key) => !BASE_EVENT_KEYS.has(key))
    .map((key) => `${key}=${JSON.stringify(e[key])}`)
    .join(" ");
}

/**
 * Best-effort webhook alert. Prefer scheduleSecurityAlert() (above) from
 * callers — call this directly only if you already have your own reason to
 * control the awaiting/scheduling yourself.
 */
export async function sendSecurityAlert(e: SecurityEvent): Promise<void> {
  const webhookUrl = process.env.SECURITY_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const extraFields = formatExtraFields(e);
    const extraSuffix = extraFields ? ` ${extraFields}` : "";
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Slack and Discord incoming webhooks both accept a top-level "text"
      // field. If you point this at some other webhook provider, adjust
      // the body shape to match what it expects.
      body: JSON.stringify({
        text: `🚨 [${e.event}] ${e.reason} — ip=${e.ip} path=${e.path} ua="${e.userAgent}"${extraSuffix} at ${e.time}`,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // Alerting must never break auth or throw into the caller. Log the
    // delivery failure itself (not the original event, already logged by
    // the caller) so a broken/expired webhook URL doesn't fail silently
    // forever — you'll see *this* line in Vercel's logs even if the
    // webhook never arrives.
    console.error(
      JSON.stringify({
        event: "security_alert_delivery_failed",
        error: err instanceof Error ? err.message : String(err),
        time: new Date().toISOString(),
      })
    );
  }
}

/**
 * Convenience wrapper combining the three steps every auth-failure call
 * site needs: build the event, always log it, and best-effort schedule the
 * webhook alert. Callers keep their own event-name string literal
 * ("mcp_auth_failure" / "oauth_authorize_failure" / "oauth_token_failure")
 * and just pass it through.
 */
export function reportSecurityFailure(
  req: Request,
  event: string,
  reason: string,
  extra?: Record<string, unknown>
): void {
  const evt = buildSecurityEvent(req, event, reason, extra);
  logSecurityEvent(evt); // always — visible in Vercel's function logs
  scheduleSecurityAlert(evt); // best-effort webhook, non-blocking
}
