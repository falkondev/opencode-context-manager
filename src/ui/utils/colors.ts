// Color palette for the dashboard
// These are blessed-compatible terminal color names

export const COLORS = {
  // Brand / structural
  header: "cyan",
  border: "cyan",
  borderFocus: "white",
  title: "cyan",
  titleBold: true,

  // Background accents
  bgSelected: "blue",
  fgSelected: "white",

  // Context gauge
  gaugeLow: "green", // < 50%
  gaugeMedium: "yellow", // 50-80%
  gaugeHigh: "red", // > 80%
  gaugeEmpty: "black",

  // Token categories
  tokenInput: "blue",
  tokenOutput: "magenta",
  tokenCache: "cyan",
  tokenReasoning: "yellow",

  // Composition categories
  compAutoContext: "yellow",
  compSystemPrompt: "#ff8700", // orange — will fallback to 'yellow' in 256color
  compUserText: "green",
  compOutput: "magenta",

  // Timeline event types
  timelineSessionCreated: "white",
  timelineMessageSent: "cyan",
  timelineStepStart: "blue",
  timelineModelResponse: "green",
  timelineStepFinish: "magenta",
  timelineToolCall: "yellow",
  timelinePatch: "gray",

  // Status indicators
  live: "green",
  warning: "yellow",
  error: "red",
  muted: "gray",
  normal: "white",

  // UI chrome
  footer: "black",
  footerText: "white",
  keyHint: "cyan",
  keyLabel: "white",
} as const;

// Inline blessed tag helpers

export function fg(color: string, text: string): string {
  return `{${color}-fg}${text}{/${color}-fg}`;
}

export function bold(text: string): string {
  return `{bold}${text}{/bold}`;
}

export function fgBold(color: string, text: string): string {
  return `{${color}-fg}{bold}${text}{/bold}{/${color}-fg}`;
}

/**
 * Returns the gauge color based on usage percentage.
 */
export function gaugeColor(percent: number): string {
  if (percent >= 80) return COLORS.gaugeHigh;
  if (percent >= 50) return COLORS.gaugeMedium;
  return COLORS.gaugeLow;
}

/**
 * Renders an ASCII progress bar using blessed tags.
 * @param filled  0-100 percentage
 * @param width   total bar width in chars
 * @param color   blessed color name for the filled portion
 */
export function asciiBar(
  filled: number,
  width: number,
  color: string,
  emptyColor = "black",
): string {
  const filledCount = Math.round((Math.min(100, Math.max(0, filled)) / 100) * width);
  const emptyCount = width - filledCount;
  const bar =
    fg(color, "█".repeat(filledCount)) + fg(emptyColor, "░".repeat(emptyCount));
  return bar;
}
