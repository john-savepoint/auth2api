/**
 * Translate Codex ChatGPT-backend rate-limit response headers into the
 * Anthropic-compatible format that Claude Code's statusline expects.
 *
 * Codex headers (from chatgpt.com/backend-api/codex/responses):
 *   x-codex-primary-used-percent       → 5hr usage as percentage (e.g. "45.2")
 *   x-codex-primary-reset-at           → Unix epoch seconds when 5hr resets
 *   x-codex-secondary-used-percent → 7d usage as percentage (e.g. "12.5")
 *   x-codex-secondary-reset-at → Unix epoch seconds when 7d resets
 *   x-codex-rate-limit-reached-type    → present when a limit is hit
 *
 * Anthropic headers (expected by Claude Code's claudeAiLimits.ts):
 *   anthropic-ratelimit-unified-5h-utilization → 0-1 fraction
 *   anthropic-ratelimit-unified-5h-reset       → Unix epoch seconds
 *   anthropic-ratelimit-unified-7d-utilization → 0-1 fraction
 *   anthropic-ratelimit-unified-7d-reset       → Unix epoch seconds
 *   anthropic-ratelimit-unified-status         → "allowed" | "rejected"
 */
export function translateCodexRateLimitHeaders(
  upstreamHeaders: Headers,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Helper: read a header value or null
  const g = (name: string): string | null => upstreamHeaders.get(name);

  // Primary (5-hour) window
  const primaryPct = g("x-codex-primary-used-percent");
  const primaryReset = g("x-codex-primary-reset-at");

  if (primaryPct !== null && primaryReset !== null) {
    const fraction = Number(primaryPct) / 100;
    result["anthropic-ratelimit-unified-5h-utilization"] = String(fraction);
    result["anthropic-ratelimit-unified-5h-reset"] = primaryReset;
  }

  // Secondary (7-day) window
  const secondaryPct = g("x-codex-secondary-used-percent");
  const secondaryReset = g("x-codex-secondary-reset-at");

  if (secondaryPct !== null && secondaryReset !== null) {
    const fraction = Number(secondaryPct) / 100;
    result["anthropic-ratelimit-unified-7d-utilization"] = String(fraction);
    result["anthropic-ratelimit-unified-7d-reset"] = secondaryReset;
  }

  // Status: if rate-limit-reached-type header is present, user is blocked
  if (g("x-codex-rate-limit-reached-type") !== null) {
    result["anthropic-ratelimit-unified-status"] = "rejected";
  } else if (
    g("x-codex-primary-used-percent") !== null ||
    g("x-codex-secondary-used-percent") !== null
  ) {
    result["anthropic-ratelimit-unified-status"] = "allowed";
  }

  return result;
}

/**
 * Apply translated rate-limit headers from the upstream Codex response onto
 * the Express response object so Claude Code's statusline picks them up.
 */
export function applyCodexRateLimitHeaders(
  upstream: Response,
  expressRes: { setHeader(name: string, value: string): any },
): void {
  const headers = translateCodexRateLimitHeaders(upstream.headers);
  for (const [name, value] of Object.entries(headers)) {
    expressRes.setHeader(name, value);
  }
  writeStatuslineCache(headers);
}

function writeStatuslineCache(headers: Record<string, string>): void {
  const fiveHourUtilization = headers["anthropic-ratelimit-unified-5h-utilization"];
  const fiveHourReset = headers["anthropic-ratelimit-unified-5h-reset"];
  const sevenDayUtilization = headers["anthropic-ratelimit-unified-7d-utilization"];
  const sevenDayReset = headers["anthropic-ratelimit-unified-7d-reset"];

  if (!fiveHourUtilization && !sevenDayUtilization) return;

  const fs = require("node:fs") as typeof import("node:fs");
  const path = "/tmp/claude-statusline-cache/codex-rate-limits.json";
  const tmpPath = `${path}.${process.pid}.tmp`;
  const data: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };

  if (fiveHourUtilization && fiveHourReset) {
    data.five_hour = {
      used_percentage: Number(fiveHourUtilization) * 100,
      resets_at: Number(fiveHourReset),
    };
  }
  if (sevenDayUtilization && sevenDayReset) {
    data.seven_day = {
      used_percentage: Number(sevenDayUtilization) * 100,
      resets_at: Number(sevenDayReset),
    };
  }

  try {
    fs.mkdirSync("/tmp/claude-statusline-cache", { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, path);
  } catch {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
  }
}
