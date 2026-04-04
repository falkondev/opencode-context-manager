import blessed from "blessed";
import type { Widgets } from "blessed";
import type { ISessionMetrics, ISessionSummary, ITimelineEvent } from "../models/metrics.ts";
import type { IAppConfig } from "../utils/config.ts";
import { saveConfig } from "../utils/config.ts";
import { t, setLanguage } from "../utils/i18n.ts";
import { LOG_FILE } from "../utils/logger.ts";
import {
  COLORS,
  fg,
  bold,
  fgBold,
  gaugeColor,
  asciiBar,
} from "./utils/colors.ts";
import {
  fmtTokens,
  fmtDuration,
  fmtTimeAgo,
  fmtTimestamp,
  fmtElapsed,
  fmtCost,
  fmtPercent,
  truncate,
  pad,
  shortModelId,
  shortDir,
} from "./utils/formatters.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const BAR_WIDTH = 24;
const SESSION_LIST_WIDTH = "28%";
const RIGHT_PANEL_WIDTH = "26%";

// ─── Dashboard ────────────────────────────────────────────────────────────────

export class Dashboard {
  private screen: Widgets.Screen;
  private config: IAppConfig;

  // Panels
  private sessionListBox!: Widgets.ListElement;
  private contextBox!: Widgets.BoxElement;
  private tokenBox!: Widgets.BoxElement;
  private timelineBox!: Widgets.BoxElement;
  private footerBox!: Widgets.BoxElement;
  private headerBox!: Widgets.BoxElement;

  // Overlays
  private detailsOverlay!: Widgets.BoxElement;
  private settingsOverlay!: Widgets.BoxElement;

  // State
  private summaries: ISessionSummary[] = [];
  private currentMetrics: ISessionMetrics | null = null;
  private selectedIndex = 0;
  private detailsVisible = false;
  private settingsVisible = false;
  private onSelectSession: ((id: string) => void) | null = null;
  private onRefreshRequest: (() => void) | null = null;

  constructor(config: IAppConfig) {
    this.config = config;

    this.screen = blessed.screen({
      smartCSR: true,
      mouse: true,
      fullUnicode: true,
      title: t("app.title"),
    });

    this.buildLayout();
    this.buildOverlays();
    this.bindKeys();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  public onSelect(cb: (id: string) => void): void {
    this.onSelectSession = cb;
  }

  public onRefresh(cb: () => void): void {
    this.onRefreshRequest = cb;
  }

  public update(summaries: ISessionSummary[], current: ISessionMetrics | null): void {
    this.summaries = summaries;
    this.currentMetrics = current;

    this.renderSessionList();
    this.renderContextPanel();
    this.renderTokenPanel();
    this.renderTimeline();
    this.renderHeader();

    if (this.detailsVisible && current) {
      this.renderDetailsOverlay(current);
    }

    this.screen.render();
  }

  public destroy(): void {
    this.screen.destroy();
  }

  // ─── Layout Construction ───────────────────────────────────────────────────

  private buildLayout(): void {
    // Header
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: COLORS.header, bg: "black", bold: true },
    });

    // Session list (left)
    this.sessionListBox = blessed.list({
      top: 3,
      left: 0,
      width: SESSION_LIST_WIDTH,
      height: "75%-3",
      label: ` ${t("panel.sessions")} `,
      tags: true,
      border: { type: "line" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scrollbar: { ch: "│" } as any,
      mouse: true,
      keys: true,
      vi: true,
      style: {
        border: { fg: COLORS.border },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.title } as any,
        selected: { bg: COLORS.bgSelected, fg: COLORS.fgSelected },
        item: { fg: "white" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollbar: { bg: COLORS.border } as any,
      },
    });

    // Context + token panels (center)
    this.contextBox = blessed.box({
      top: 3,
      left: SESSION_LIST_WIDTH,
      width: `${100 - 28 - 26}%`,
      height: "75%-3",
      label: ` ${t("panel.context")} `,
      tags: true,
      border: { type: "line" },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      style: {
        border: { fg: COLORS.border },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.title, bold: true } as any,
        fg: "white",
      },
    });

    // Token breakdown (right)
    this.tokenBox = blessed.box({
      top: 3,
      left: `${28 + (100 - 28 - 26)}%`,
      width: RIGHT_PANEL_WIDTH,
      height: "75%-3",
      label: ` ${t("panel.composition")} `,
      tags: true,
      border: { type: "line" },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      style: {
        border: { fg: COLORS.border },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.title, bold: true } as any,
        fg: "white",
      },
    });

    // Timeline (bottom)
    this.timelineBox = blessed.box({
      top: "75%",
      left: 0,
      width: "100%",
      height: "25%-3",
      label: ` ${t("panel.timeline")} `,
      tags: true,
      border: { type: "line" },
      scrollable: true,
      alwaysScroll: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scrollbar: { ch: "│" } as any,
      mouse: true,
      style: {
        border: { fg: COLORS.border },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.title } as any,
        fg: "white",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollbar: { bg: COLORS.border } as any,
      },
    });

    // Footer
    this.footerBox = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: COLORS.footerText, bg: "black" },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.sessionListBox);
    this.screen.append(this.contextBox);
    this.screen.append(this.tokenBox);
    this.screen.append(this.timelineBox);
    this.screen.append(this.footerBox);

    this.renderFooter();
    this.sessionListBox.focus();
  }

  private buildOverlays(): void {
    // Technical details overlay
    this.detailsOverlay = blessed.box({
      top: "center",
      left: "center",
      width: "80%",
      height: "80%",
      label: ` ${t("panel.details")} `,
      tags: true,
      border: { type: "line" },
      scrollable: true,
      alwaysScroll: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scrollbar: { ch: "│" } as any,
      keys: true,
      mouse: true,
      hidden: true,
      style: {
        border: { fg: "white" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: "white" } as any,
        fg: "white",
        bg: "black",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollbar: { bg: "gray" } as any,
      },
    });

    // Settings overlay
    this.settingsOverlay = blessed.box({
      top: "center",
      left: "center",
      width: 50,
      height: 18,
      label: ` ${t("panel.settings")} `,
      tags: true,
      border: { type: "line" },
      keys: true,
      mouse: true,
      hidden: true,
      style: {
        border: { fg: COLORS.border },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.title, bold: true } as any,
        fg: "white",
        bg: "black",
      },
    });

    this.screen.append(this.detailsOverlay);
    this.screen.append(this.settingsOverlay);
  }

  // ─── Key / Mouse Bindings ──────────────────────────────────────────────────

  private bindKeys(): void {
    // Quit
    this.screen.key(["q", "Q", "C-c"], () => {
      this.destroy();
      process.exit(0);
    });

    // Refresh
    this.screen.key(["r", "R"], () => {
      this.onRefreshRequest?.();
    });

    // Technical details toggle
    this.screen.key(["d", "D"], () => {
      this.toggleDetails();
    });

    // Settings toggle
    this.screen.key(["c", "C"], () => {
      this.toggleSettings();
    });

    // Navigate sessions
    this.screen.key(["up", "k"], () => {
      if (this.detailsVisible || this.settingsVisible) return;
      this.navigateSession(-1);
    });
    this.screen.key(["down", "j"], () => {
      if (this.detailsVisible || this.settingsVisible) return;
      this.navigateSession(1);
    });

    // Session list mouse click
    this.sessionListBox.on("select", (_el, index) => {
      this.selectSessionAt(index);
    });

    // Close overlays with Escape or Enter
    this.detailsOverlay.key(["escape", "q", "d", "D"], () => {
      this.hideDetails();
    });
    this.settingsOverlay.key(["escape", "q"], () => {
      this.hideSettings();
    });

    // Footer button-like hints clickable area
    this.footerBox.on("click", (data) => {
      const x = data.x;
      const w = this.screen.width as number;
      const quarter = Math.floor(w / 5);
      if (x < quarter) {
        // navigate — do nothing special
      } else if (x < quarter * 2) {
        this.toggleDetails();
      } else if (x < quarter * 3) {
        this.toggleSettings();
      } else if (x < quarter * 4) {
        this.onRefreshRequest?.();
      } else {
        this.destroy();
        process.exit(0);
      }
    });
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  private navigateSession(delta: number): void {
    if (this.summaries.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.summaries.length - 1, this.selectedIndex + delta),
    );
    this.sessionListBox.select(this.selectedIndex);
    const s = this.summaries[this.selectedIndex];
    if (s) this.onSelectSession?.(s.id);
    this.screen.render();
  }

  private selectSessionAt(index: number): void {
    if (index < 0 || index >= this.summaries.length) return;
    this.selectedIndex = index;
    const s = this.summaries[index];
    if (s) this.onSelectSession?.(s.id);
  }

  // ─── Overlay Toggles ───────────────────────────────────────────────────────

  private toggleDetails(): void {
    if (this.settingsVisible) this.hideSettings();
    this.detailsVisible ? this.hideDetails() : this.showDetails();
  }

  private showDetails(): void {
    if (!this.currentMetrics) return;
    this.detailsVisible = true;
    this.renderDetailsOverlay(this.currentMetrics);
    this.detailsOverlay.show();
    this.detailsOverlay.focus();
    this.screen.render();
  }

  private hideDetails(): void {
    this.detailsVisible = false;
    this.detailsOverlay.hide();
    this.sessionListBox.focus();
    this.screen.render();
  }

  private toggleSettings(): void {
    if (this.detailsVisible) this.hideDetails();
    this.settingsVisible ? this.hideSettings() : this.showSettings();
  }

  private showSettings(): void {
    this.settingsVisible = true;
    this.renderSettingsOverlay();
    this.settingsOverlay.show();
    this.settingsOverlay.focus();
    this.screen.render();
  }

  private hideSettings(): void {
    this.settingsVisible = false;
    this.settingsOverlay.hide();
    this.sessionListBox.focus();
    this.screen.render();
  }

  // ─── Renderers ─────────────────────────────────────────────────────────────

  private renderHeader(): void {
    const m = this.currentMetrics;
    const title = fgBold(COLORS.header, t("app.title"));
    let right = "";

    if (m?.is_live) {
      right = `  ${fgBold(COLORS.live, "⬤")} ${fgBold(COLORS.live, t("app.live"))}`;
    }

    const sessions = this.summaries.length;
    const count = fg(COLORS.muted, `${sessions} sessions`);
    const logHint = fg(COLORS.muted, `log: ${LOG_FILE}`);
    const line1 = ` ${title}${right}  ${count}`;
    const line2 = ` ${fg(COLORS.muted, "─".repeat(30))}  ${logHint}`;
    this.headerBox.setContent(`${line1}\n${line2}`);
  }

  private renderSessionList(): void {
    const items = this.summaries.map((s) => {
      const liveTag = s.is_live ? fg(COLORS.live, "⬤ ") : "  ";
      const title = truncate(s.title, 20);
      const model = truncate(shortModelId(s.model_id), 12);
      const pct = s.has_data ? fg(gaugeColor(s.context_percentage), `${s.context_percentage}%`) : "";
      const tokens = s.has_data ? fg(COLORS.muted, fmtTokens(s.total_tokens, true)) : fg(COLORS.muted, "—");
      const age = fg(COLORS.muted, fmtTimeAgo(s.time_created));

      return `${liveTag}${title}  ${fg(COLORS.muted, model)}  ${pct} ${tokens}  ${age}`;
    });

    this.sessionListBox.setItems(items as string[]);
    this.sessionListBox.select(this.selectedIndex);
  }

  private renderContextPanel(): void {
    const m = this.currentMetrics;
    if (!m) {
      this.contextBox.setContent(`\n  ${fg(COLORS.muted, t("session.no_data"))}`);
      return;
    }

    const lines: string[] = [];

    // Session identity
    lines.push("");
    lines.push(`  ${fgBold(COLORS.header, truncate(m.session.title, 40))}`);
    lines.push(`  ${fg(COLORS.muted, shortDir(m.session.directory))}`);
    lines.push("");

    // Model / provider row
    lines.push(
      `  ${fg(COLORS.muted, t("session.model") + ":")}  ` +
      fgBold("white", shortModelId(m.model_id)) +
      `  ${fg(COLORS.muted, m.provider_id)}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("session.agent") + ":")}   ` +
      fg("cyan", m.agent) +
      `   ${fg(COLORS.muted, t("session.finish") + ":")} ` +
      fg(m.finish_reason === "stop" ? "green" : "yellow", m.finish_reason),
    );
    lines.push("");

    // Context window bar
    const pct = m.context_percentage;
    const color = gaugeColor(pct);
    const bar = asciiBar(pct, BAR_WIDTH, color, "black");
    const pctLabel = fgBold(color, `${pct}%`);
    lines.push(`  ${fgBold(COLORS.header, t("context.percentage"))}  ${pctLabel}`);
    lines.push(`  ${bar}  ${fg(COLORS.muted, fmtTokens(m.tokens.total) + " / " + fmtTokens(m.context_limit))}`);
    lines.push(`  ${fg(COLORS.muted, fmtTokens(m.context_limit - m.tokens.total) + " " + t("misc.free"))}`);
    lines.push("");

    // Token bars
    const total = m.tokens.total;
    const inputPct = total > 0 ? (m.tokens.input / total) * 100 : 0;
    const outputPct = total > 0 ? (m.tokens.output / total) * 100 : 0;
    const cachePct = total > 0 ? (m.tokens.cache_read / total) * 100 : 0;
    const reasoningPct = total > 0 ? (m.tokens.reasoning / total) * 100 : 0;

    lines.push(`  ${fgBold("white", t("tokens.total"))}  ${fgBold("white", fmtTokens(total))}`);
    lines.push("");

    const renderBar = (label: string, pctVal: number, count: number, color: string) => {
      const bar = asciiBar(pctVal, BAR_WIDTH, color, "black");
      const pctStr = fg(color, pad(fmtPercent(pctVal), 7, true));
      const cnt = fg(COLORS.muted, fmtTokens(count));
      return `  ${pad(label, 10)} ${bar}  ${pctStr}  ${cnt}`;
    };

    lines.push(renderBar(t("tokens.input"), inputPct, m.tokens.input, COLORS.tokenInput));
    lines.push(renderBar(t("tokens.output"), outputPct, m.tokens.output, COLORS.tokenOutput));
    if (m.tokens.cache_read > 0) {
      lines.push(renderBar(t("tokens.cache_read"), cachePct, m.tokens.cache_read, COLORS.tokenCache));
    }
    if (m.tokens.reasoning > 0) {
      lines.push(renderBar(t("tokens.reasoning"), reasoningPct, m.tokens.reasoning, COLORS.tokenReasoning));
    }
    lines.push("");

    // Timing
    lines.push(`  ${fg(COLORS.muted, t("session.duration") + ":")}  ` +
      fgBold("white", fmtDuration(m.duration_total_ms)) +
      `  ${fg(COLORS.muted, "(model: " + fmtDuration(m.duration_model_ms) + ")") }`);

    // Cost
    lines.push(`  ${fg(COLORS.muted, t("session.cost") + ":")}      ` +
      fg(m.cost === 0 ? "green" : "white", fmtCost(m.cost)));

    // Steps / tool calls
    if (m.step_count > 0 || m.tool_calls_count > 0) {
      lines.push(`  ${fg(COLORS.muted, t("session.steps") + ":")}  ` +
        fg("cyan", `${m.step_count}`) +
        `  ${fg(COLORS.muted, t("session.tool_calls") + ":")} ` +
        fg("cyan", `${m.tool_calls_count}`)
      );
    }

    this.contextBox.setContent(lines.join("\n"));
  }

  private renderTokenPanel(): void {
    const m = this.currentMetrics;
    if (!m) {
      this.tokenBox.setContent(`\n  ${fg(COLORS.muted, t("session.no_data"))}`);
      return;
    }

    const lines: string[] = [];
    const comp = m.token_composition;
    const totalInput = m.tokens.input;

    lines.push("");
    lines.push(`  ${fgBold(COLORS.header, t("panel.composition"))} ${fg(COLORS.muted, t("composition.estimated"))}`);
    lines.push("");

    const renderRow = (label: string, tokens: number, color: string, symbol: string) => {
      const pct = totalInput > 0 ? (tokens / totalInput) * 100 : 0;
      const bar = asciiBar(pct, 14, color, "black");
      const pctStr = fg(color, pad(fmtPercent(pct), 7, true));
      const cnt = fg(COLORS.muted, fmtTokens(tokens, true));
      return `  ${fg(color, symbol)} ${pad(truncate(label, 12), 12)} ${bar} ${pctStr} ${cnt}`;
    };

    lines.push(renderRow(t("composition.auto_context"), comp.auto_context_tokens, COLORS.compAutoContext, "■"));
    lines.push(renderRow(t("composition.system_prompt"), comp.system_prompt_tokens, "yellow", "■"));
    lines.push(renderRow(t("composition.user_text"), comp.user_text_tokens, COLORS.compUserText, "■"));
    lines.push(renderRow(t("composition.output"), m.tokens.output, COLORS.compOutput, "■"));

    if (m.tokens.cache_read > 0) {
      lines.push(renderRow(t("tokens.cache_read"), m.tokens.cache_read, COLORS.tokenCache, "■"));
    }

    lines.push("");

    // Auto-context warning
    if (m.injected_diffs_count > 0) {
      const diffsPct = totalInput > 0 ? Math.round((comp.auto_context_tokens / totalInput) * 100) : 0;
      lines.push(`  ${fg(COLORS.warning, "⚠")} ${fg(COLORS.warning, `${m.injected_diffs_count} ${t("composition.diffs_injected")}`)}`);
      lines.push(`  ${fg(COLORS.muted, "  " + diffsPct + "% of input was auto-injected")}`);
    }

    lines.push("");
    lines.push(`  ${fg(COLORS.muted, "─".repeat(20))}`);
    lines.push(`  ${fg(COLORS.muted, "Created")}  ${fg("white", fmtTimestamp(m.session.time_created))}`);
    lines.push(`  ${fg(COLORS.muted, "Updated")}  ${fg("white", fmtTimeAgo(m.session.time_updated))}`);
    lines.push(`  ${fg(COLORS.muted, "Files Δ")}  ${fg("cyan", `+${m.session.summary_additions ?? 0}`)}`+
      `  ${fg("magenta", `-${m.session.summary_deletions ?? 0}`)}`);

    this.tokenBox.setContent(lines.join("\n"));
  }

  private renderTimeline(): void {
    const m = this.currentMetrics;
    if (!m || m.timeline.length === 0) {
      this.timelineBox.setContent(`\n  ${fg(COLORS.muted, t("session.no_data"))}`);
      return;
    }

    const lines: string[] = [""];

    for (const event of m.timeline) {
      const line = this.formatTimelineEvent(event);
      lines.push(line);
    }

    this.timelineBox.setContent(lines.join("\n"));
  }

  private formatTimelineEvent(event: ITimelineEvent): string {
    const elapsed = fgBold("white", pad(fmtElapsed(event.elapsed_ms), 8));

    let icon: string = "●";
    let color: string = COLORS.timelineSessionCreated;
    let label = event.label;

    switch (event.type) {
      case "session-created":
        icon = "◆";
        color = COLORS.timelineSessionCreated;
        label = truncate(event.label, 45);
        break;
      case "message-sent":
        icon = "→";
        color = COLORS.timelineMessageSent;
        label = t("timeline.message_sent");
        break;
      case "step-start":
        icon = "▶";
        color = COLORS.timelineStepStart;
        label = t("timeline.step_start");
        break;
      case "step-finish":
        icon = "■";
        color = COLORS.timelineStepFinish;
        label = t("timeline.step_finish");
        break;
      case "model-response":
        icon = "✓";
        color = COLORS.timelineModelResponse;
        label = t("timeline.model_response");
        break;
      case "tool-call":
        icon = "⚙";
        color = COLORS.timelineToolCall;
        label = t("timeline.tool_call");
        break;
      case "patch":
        icon = "⊕";
        color = COLORS.timelinePatch;
        label = t("timeline.patch");
        break;
    }

    const detail = event.detail ? `  ${fg(COLORS.muted, event.detail)}` : "";
    return `  ${elapsed}  ${fg(color, icon)}  ${fg(color, label)}${detail}`;
  }

  private renderDetailsOverlay(m: ISessionMetrics): void {
    const lines: string[] = [""];

    // Header
    lines.push(`  ${fgBold(COLORS.header, t("details.session_id"))}`);
    lines.push(`  ${fg("white", m.session.id)}`);
    lines.push("");
    lines.push(`  ${fgBold(COLORS.header, t("session.title"))}`);
    lines.push(`  ${fg("white", m.session.title)}`);
    lines.push("");
    lines.push(`  ${fgBold(COLORS.header, t("session.model"))}:  ${fg("white", m.model_id)}`);
    lines.push(`  ${fgBold(COLORS.header, t("session.provider"))}:  ${fg("white", m.provider_id)}`);
    lines.push(`  ${fgBold(COLORS.header, t("session.agent"))}:  ${fg("white", m.agent)}`);
    lines.push(`  ${fgBold(COLORS.header, t("session.finish"))}:  ${fg("white", m.finish_reason)}`);
    lines.push("");

    // Token raw data
    lines.push(`  ${fgBold(COLORS.header, t("details.raw_tokens"))}`);
    lines.push(`  ${fg(COLORS.muted, "total")}        ${fg("white", fmtTokens(m.tokens.total))}`);
    lines.push(`  ${fg(COLORS.muted, "input")}        ${fg(COLORS.tokenInput, fmtTokens(m.tokens.input))}`);
    lines.push(`  ${fg(COLORS.muted, "output")}       ${fg(COLORS.tokenOutput, fmtTokens(m.tokens.output))}`);
    lines.push(`  ${fg(COLORS.muted, "reasoning")}    ${fg(COLORS.tokenReasoning, fmtTokens(m.tokens.reasoning))}`);
    lines.push(`  ${fg(COLORS.muted, "cache.read")}   ${fg(COLORS.tokenCache, fmtTokens(m.tokens.cache_read))}`);
    lines.push(`  ${fg(COLORS.muted, "cache.write")}  ${fg(COLORS.tokenCache, fmtTokens(m.tokens.cache_write))}`);
    lines.push("");

    // Context window
    lines.push(`  ${fgBold(COLORS.header, t("context.limit"))}:  ${fg("white", fmtTokens(m.context_limit))}`);
    lines.push(`  ${fgBold(COLORS.header, t("context.percentage"))}:  ${fg(gaugeColor(m.context_percentage), m.context_percentage + "%")}`);
    lines.push("");

    // Timing
    lines.push(`  ${fgBold(COLORS.header, "Timing")}`);
    lines.push(`  ${fg(COLORS.muted, "session start")}:  ${fg("white", fmtTimestamp(m.session.time_created))}`);
    lines.push(`  ${fg(COLORS.muted, "total duration")}:  ${fg("white", fmtDuration(m.duration_total_ms))}`);
    lines.push(`  ${fg(COLORS.muted, "model time")}:      ${fg("white", fmtDuration(m.duration_model_ms))}`);
    lines.push("");

    // User message info
    lines.push(`  ${fgBold(COLORS.header, t("details.data_size"))}:  ${fg("white", m.user_message_byte_size.toLocaleString() + " " + t("details.chars"))}`);
    lines.push(`  ${fg(COLORS.muted, t("composition.diffs_injected") + ":")}  ${fg(COLORS.compAutoContext, String(m.injected_diffs_count))}`);
    lines.push(`  ${fg(COLORS.muted, t("session.steps") + ":")}              ${fg("cyan", String(m.step_count))}`);
    lines.push(`  ${fg(COLORS.muted, t("session.tool_calls") + ":")}         ${fg("cyan", String(m.tool_calls_count))}`);
    lines.push("");

    // Git
    lines.push(`  ${fgBold(COLORS.header, "Git Summary")}`);
    lines.push(`  ${fg(COLORS.muted, "files")}  ${fg("white", String(m.session.summary_files ?? 0))}`);
    lines.push(`  ${fg(COLORS.muted, "add")}    ${fg("green", "+" + (m.session.summary_additions ?? 0))}`);
    lines.push(`  ${fg(COLORS.muted, "del")}    ${fg("red", "-" + (m.session.summary_deletions ?? 0))}`);
    lines.push("");

    // Token composition estimates
    lines.push(`  ${fgBold(COLORS.header, "Token Composition")} ${fg(COLORS.muted, "(estimated)")}`);
    lines.push(`  ${fg(COLORS.muted, "auto-context")}:   ${fg(COLORS.compAutoContext, fmtTokens(m.token_composition.auto_context_tokens))}`);
    lines.push(`  ${fg(COLORS.muted, "system prompt")}:  ${fg("yellow", fmtTokens(m.token_composition.system_prompt_tokens))}`);
    lines.push(`  ${fg(COLORS.muted, "user text")}:      ${fg(COLORS.compUserText, fmtTokens(m.token_composition.user_text_tokens))}`);
    lines.push("");

    lines.push(`  ${fg(COLORS.muted, "Press ")}${fgBold("white", "Escape")}${fg(COLORS.muted, " or ")}${fgBold("white", "D")}${fg(COLORS.muted, " to close")}`);

    this.detailsOverlay.setContent(lines.join("\n"));
  }

  private renderSettingsOverlay(): void {
    this.settingsOverlay.setContent("");

    const langEn = this.config.language === "en";
    const en = blessed.radiobutton({
      parent: this.settingsOverlay,
      top: 2,
      left: 3,
      content: "English",
      checked: langEn,
      mouse: true,
      style: { fg: "white" },
    });

    const ptBr = blessed.radiobutton({
      parent: this.settingsOverlay,
      top: 4,
      left: 3,
      content: "Português Brasileiro",
      checked: !langEn,
      mouse: true,
      style: { fg: "white" },
    });

    const label = blessed.text({
      parent: this.settingsOverlay,
      top: 1,
      left: 2,
      content: fgBold(COLORS.header, t("settings.language")),
      tags: true,
    });

    const sep = blessed.text({
      parent: this.settingsOverlay,
      top: 6,
      left: 2,
      content: fg(COLORS.muted, "─".repeat(40)),
      tags: true,
    });

    const refreshLabel = blessed.text({
      parent: this.settingsOverlay,
      top: 7,
      left: 2,
      content: fgBold(COLORS.header, t("settings.refresh_interval")),
      tags: true,
    });

    const refreshOptions = [1, 2, 5, 10];
    let selectedRefresh = refreshOptions.indexOf(this.config.refreshInterval);
    if (selectedRefresh < 0) selectedRefresh = 1;

    const refreshRadios = refreshOptions.map((sec, i) => {
      return blessed.radiobutton({
        parent: this.settingsOverlay,
        top: 8,
        left: 3 + i * 7,
        content: `${sec}s`,
        checked: i === selectedRefresh,
        mouse: true,
        style: { fg: "white" },
      });
    });

    const saveBtn = blessed.button({
      parent: this.settingsOverlay,
      top: 11,
      left: 3,
      width: 12,
      height: 3,
      content: `  ${t("settings.save")}  `,
      tags: true,
      border: { type: "line" },
      mouse: true,
      keys: true,
      style: {
        fg: "black",
        bg: "green",
        border: { fg: "green" },
        focus: { bg: "white" },
        hover: { bg: "white" },
      },
    });

    const cancelBtn = blessed.button({
      parent: this.settingsOverlay,
      top: 11,
      left: 18,
      width: 14,
      height: 3,
      content: `  ${t("settings.cancel")}  `,
      tags: true,
      border: { type: "line" },
      mouse: true,
      keys: true,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "gray" },
        focus: { bg: "gray" },
        hover: { bg: "gray" },
      },
    });

    const hintText = blessed.text({
      parent: this.settingsOverlay,
      top: 15,
      left: 2,
      content: fg(COLORS.muted, "ESC to cancel"),
      tags: true,
    });

    // Suppress unused variable warnings via reference
    void label; void sep; void refreshLabel; void hintText;

    saveBtn.on("press", () => {
      const lang = en.checked ? "en" : ("pt-BR" as const);
      const refreshIdx = refreshRadios.findIndex((r) => r.checked);
      const refreshSec = refreshOptions[refreshIdx >= 0 ? refreshIdx : 1] ?? 2;

      this.config.language = lang;
      this.config.refreshInterval = refreshSec;
      setLanguage(lang);
      saveConfig(this.config);

      // Re-label all panels
      this.updatePanelLabels();
      this.onRefreshRequest?.();

      this.hideSettings();
      this.renderFooter();
    });

    cancelBtn.on("press", () => {
      this.hideSettings();
    });

    this.screen.render();
  }

  private renderFooter(): void {
    const sep = fg(COLORS.muted, " │ ");
    const hint = (key: string, label: string) =>
      `${fgBold(COLORS.keyHint, key)} ${fg(COLORS.keyLabel, label)}`;

    const line =
      ` ${hint("↑↓", t("keys.navigate"))}` +
      sep +
      hint("D", t("keys.details")) +
      sep +
      hint("C", t("keys.settings")) +
      sep +
      hint("R", t("keys.refresh")) +
      sep +
      hint("Q", t("keys.quit"));

    this.footerBox.setContent(`\n${line}`);
  }

  private updatePanelLabels(): void {
    this.sessionListBox.options.label = ` ${t("panel.sessions")} `;
    this.contextBox.options.label = ` ${t("panel.context")} `;
    this.tokenBox.options.label = ` ${t("panel.composition")} `;
    this.timelineBox.options.label = ` ${t("panel.timeline")} `;
  }
}
