/**
 * Formats a token count as a localized string with optional short form.
 */
export function fmtTokens(n: number, short = false): string {
  if (short) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  }
  return n.toLocaleString("en-US");
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = (seconds % 60).toFixed(0).padStart(2, "0");
  return `${minutes}m${rem}s`;
}

/**
 * Formats a timestamp (epoch ms) to a relative string from now.
 */
export function fmtTimeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Formats an epoch ms timestamp to a short date+time string.
 */
export function fmtTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Formats an elapsed ms (relative to session start) as "+Xs" or "+Xm Ys".
 */
export function fmtElapsed(ms: number): string {
  if (ms < 0) return "+0.0s";
  const s = ms / 1_000;
  if (s < 60) return `+${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0).padStart(2, "0");
  return `+${m}m${rem}s`;
}

/**
 * Formats a cost in USD.
 */
export function fmtCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.001) return `$${cost.toFixed(5)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Formats a percentage with one decimal place.
 */
export function fmtPercent(n: number): string {
  if (n < 0.1 && n > 0) return "<0.1%";
  return `${n.toFixed(1)}%`;
}

/**
 * Truncates a string with ellipsis if longer than maxLen.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Pads a string to a fixed width (right-aligned if rightAlign).
 */
export function pad(str: string, width: number, rightAlign = false): string {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  const spaces = " ".repeat(width - s.length);
  return rightAlign ? spaces + s : s + spaces;
}

/**
 * Formats byte size as KB/MB.
 */
export function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Shortens a model ID for display (removes provider prefixes, normalizes).
 */
export function shortModelId(modelId: string): string {
  return modelId
    .replace(/^claude-/i, "")
    .replace(/-(\d)/g, " $1")
    .replace(/-/g, " ");
}

/**
 * Shortens a directory path for display.
 */
export function shortDir(dir: string): string {
  const home = process.env["HOME"] ?? "";
  if (home && dir.startsWith(home)) {
    return "~" + dir.slice(home.length);
  }
  return dir;
}
