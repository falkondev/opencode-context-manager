import blessed from "blessed";
import type { Widgets } from "blessed";
import type {
  ISessionMetrics,
  ISessionSummary,
  ITimelineEvent,
  IStepMetrics,
  IToolDetail,
  IToolAggregation,
  ISubagentDetail,
} from "../models/metrics.ts";
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
  private stepsOverlay!: Widgets.BoxElement;
  private toolsOverlay!: Widgets.BoxElement;
  private subagentOverlay!: Widgets.BoxElement;

  // State
  private summaries: ISessionSummary[] = [];
  private currentMetrics: ISessionMetrics | null = null;
  private selectedIndex = 0;
  private detailsVisible = false;
  private settingsVisible = false;
  private stepsVisible = false;
  private toolsVisible = false;
  private subagentVisible = false;
  private selectedSubagentIndex = 0;
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
    if (this.stepsVisible && current) {
      this.renderStepsOverlay(current.steps, current.context_limit);
    }
    if (this.toolsVisible && current) {
      this.renderToolsOverlay(current.tools_detail, current.tools_aggregation);
    }
    if (this.subagentVisible && current) {
      const sub = current.subagent_details[this.selectedSubagentIndex];
      if (sub) this.renderSubagentOverlay(sub, this.selectedSubagentIndex, current.subagent_details.length);
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

    // Context panel (center)
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
    const overlayBase = {
      tags: true,
      border: { type: "line" as const },
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
    };

    // Technical details overlay (D)
    this.detailsOverlay = blessed.box({
      top: "center",
      left: "center",
      width: "80%",
      height: "80%",
      label: ` ${t("panel.details")} `,
      ...overlayBase,
    });

    // Steps overlay (S)
    this.stepsOverlay = blessed.box({
      top: "center",
      left: "center",
      width: "85%",
      height: "85%",
      label: ` ${t("panel.steps")} `,
      ...overlayBase,
    });

    // Tools overlay (T)
    this.toolsOverlay = blessed.box({
      top: "center",
      left: "center",
      width: "80%",
      height: "80%",
      label: ` ${t("panel.tools")} `,
      ...overlayBase,
    });

    // Subagent overlay (A)
    this.subagentOverlay = blessed.box({
      top: "center",
      left: "center",
      width: "82%",
      height: "85%",
      label: ` ${t("panel.subagent")} `,
      ...overlayBase,
    });

    // Settings overlay (C) — not scrollable, fixed size
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
    this.screen.append(this.stepsOverlay);
    this.screen.append(this.toolsOverlay);
    this.screen.append(this.subagentOverlay);
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
      this.closeAllOverlays();
      this.toggleDetails();
    });

    // Settings toggle
    this.screen.key(["c", "C"], () => {
      this.closeAllOverlays();
      this.toggleSettings();
    });

    // Steps overlay toggle
    this.screen.key(["s", "S"], () => {
      this.closeAllOverlays();
      this.toggleSteps();
    });

    // Tools overlay toggle
    this.screen.key(["t", "T"], () => {
      this.closeAllOverlays();
      this.toggleTools();
    });

    // Subagents overlay toggle
    this.screen.key(["a", "A"], () => {
      this.closeAllOverlays();
      this.toggleSubagent();
    });

    // Navigate sessions
    this.screen.key(["up", "k"], () => {
      if (this.anyOverlayVisible()) return;
      this.navigateSession(-1);
    });
    this.screen.key(["down", "j"], () => {
      if (this.anyOverlayVisible()) return;
      this.navigateSession(1);
    });

    // Session list mouse click
    this.sessionListBox.on("select", (_el, index) => {
      this.selectSessionAt(index);
    });

    // Close overlays with Escape / q / respective key
    const closeKeys = ["escape", "q", "Q"] as const;
    this.detailsOverlay.key([...closeKeys, "d", "D"], () => this.hideDetails());
    this.stepsOverlay.key([...closeKeys, "s", "S"], () => this.hideSteps());
    this.toolsOverlay.key([...closeKeys, "t", "T"], () => this.hideTools());
    this.subagentOverlay.key([...closeKeys, "a", "A"], () => this.hideSubagent());
    // Navigate between subagents with left/right arrows (or h/l)
    this.subagentOverlay.key(["right", "l", "L"], () => this.navigateSubagent(1));
    this.subagentOverlay.key(["left", "h", "H"], () => this.navigateSubagent(-1));
    this.settingsOverlay.key([...closeKeys], () => this.hideSettings());

    // Footer click areas
    this.footerBox.on("click", (data) => {
      const x = data.x;
      const w = this.screen.width as number;
      const seg = Math.floor(w / 7);
      if (x < seg) {
        // navigate — nothing
      } else if (x < seg * 2) {
        this.closeAllOverlays(); this.toggleDetails();
      } else if (x < seg * 3) {
        this.closeAllOverlays(); this.toggleSteps();
      } else if (x < seg * 4) {
        this.closeAllOverlays(); this.toggleTools();
      } else if (x < seg * 5) {
        this.closeAllOverlays(); this.toggleSubagent();
      } else if (x < seg * 6) {
        this.closeAllOverlays(); this.toggleSettings();
      } else {
        this.onRefreshRequest?.();
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

  // ─── Overlay Management ────────────────────────────────────────────────────

  private anyOverlayVisible(): boolean {
    return (
      this.detailsVisible ||
      this.settingsVisible ||
      this.stepsVisible ||
      this.toolsVisible ||
      this.subagentVisible
    );
  }

  private closeAllOverlays(): void {
    if (this.detailsVisible) this.hideDetails();
    if (this.settingsVisible) this.hideSettings();
    if (this.stepsVisible) this.hideSteps();
    if (this.toolsVisible) this.hideTools();
    if (this.subagentVisible) this.hideSubagent();
  }

  private toggleDetails(): void {
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

  private toggleSteps(): void {
    this.stepsVisible ? this.hideSteps() : this.showSteps();
  }

  private showSteps(): void {
    if (!this.currentMetrics) return;
    this.stepsVisible = true;
    this.renderStepsOverlay(this.currentMetrics.steps, this.currentMetrics.context_limit);
    this.stepsOverlay.show();
    this.stepsOverlay.focus();
    this.screen.render();
  }

  private hideSteps(): void {
    this.stepsVisible = false;
    this.stepsOverlay.hide();
    this.sessionListBox.focus();
    this.screen.render();
  }

  private toggleTools(): void {
    this.toolsVisible ? this.hideTools() : this.showTools();
  }

  private showTools(): void {
    if (!this.currentMetrics) return;
    this.toolsVisible = true;
    this.renderToolsOverlay(
      this.currentMetrics.tools_detail,
      this.currentMetrics.tools_aggregation,
    );
    this.toolsOverlay.show();
    this.toolsOverlay.focus();
    this.screen.render();
  }

  private hideTools(): void {
    this.toolsVisible = false;
    this.toolsOverlay.hide();
    this.sessionListBox.focus();
    this.screen.render();
  }

  private toggleSubagent(): void {
    this.subagentVisible ? this.hideSubagent() : this.showSubagent();
  }

  private showSubagent(): void {
    if (!this.currentMetrics || this.currentMetrics.subagent_details.length === 0) return;
    this.subagentVisible = true;
    // Default to first subagent
    this.selectedSubagentIndex = 0;
    const sub = this.currentMetrics.subagent_details[0];
    if (sub) {
      this.renderSubagentOverlay(sub, 0, this.currentMetrics.subagent_details.length);
      this.subagentOverlay.show();
      this.subagentOverlay.focus();
      this.screen.render();
    }
  }

  private hideSubagent(): void {
    this.subagentVisible = false;
    this.subagentOverlay.hide();
    this.sessionListBox.focus();
    this.screen.render();
  }

  private navigateSubagent(delta: number): void {
    if (!this.currentMetrics) return;
    const total = this.currentMetrics.subagent_details.length;
    if (total === 0) return;
    this.selectedSubagentIndex = (this.selectedSubagentIndex + delta + total) % total;
    const sub = this.currentMetrics.subagent_details[this.selectedSubagentIndex];
    if (sub) {
      this.subagentOverlay.scrollTo(0);
      this.renderSubagentOverlay(sub, this.selectedSubagentIndex, total);
      this.screen.render();
    }
  }

  private toggleSettings(): void {
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

    // ── Current context window (last step) ─────────────────────────────────
    const lastPct = m.last_step_context_percentage;
    const lastTokens = m.last_step_tokens;
    const lastColor = gaugeColor(lastPct);
    const stepNum = m.step_count;

    lines.push(`  ${fgBold(COLORS.header, t("context.current_window"))}`);
    if (stepNum > 0) {
      lines.push(`  ${fg(COLORS.muted, t("context.step_label"))} ${fgBold("white", `${stepNum}/${stepNum}`)}`);
    }
    const lastBar = asciiBar(lastPct, BAR_WIDTH, lastColor, "black");
    const lastPctLabel = fgBold(lastColor, `${lastPct}%`);
    lines.push(`  ${lastBar}  ${lastPctLabel}`);
    lines.push(
      `  ${fg(COLORS.muted, fmtTokens(lastTokens.total) + " / " + fmtTokens(m.context_limit))}` +
      `  ${fg(COLORS.muted, fmtTokens(m.context_limit - lastTokens.total) + " " + t("misc.free"))}`,
    );
    lines.push("");

    // Token breakdown for the last step
    const lastTotal = lastTokens.total;
    const renderBar = (label: string, pctVal: number, count: number, color: string) => {
      const bar = asciiBar(pctVal, BAR_WIDTH, color, "black");
      const pctStr = fg(color, pad(fmtPercent(pctVal), 7, true));
      const cnt = fg(COLORS.muted, fmtTokens(count));
      return `  ${pad(label, 10)} ${bar}  ${pctStr}  ${cnt}`;
    };

    const inputPct = lastTotal > 0 ? (lastTokens.input / lastTotal) * 100 : 0;
    const outputPct = lastTotal > 0 ? (lastTokens.output / lastTotal) * 100 : 0;
    const cachePct = lastTotal > 0 ? (lastTokens.cache_read / lastTotal) * 100 : 0;
    const reasoningPct = lastTotal > 0 ? (lastTokens.reasoning / lastTotal) * 100 : 0;

    lines.push(renderBar(t("tokens.input"), inputPct, lastTokens.input, COLORS.tokenInput));
    if (lastTokens.cache_read > 0) {
      lines.push(renderBar(t("tokens.cache_read"), cachePct, lastTokens.cache_read, COLORS.tokenCache));
    }
    lines.push(renderBar(t("tokens.output"), outputPct, lastTokens.output, COLORS.tokenOutput));
    if (lastTokens.reasoning > 0) {
      lines.push(renderBar(t("tokens.reasoning"), reasoningPct, lastTokens.reasoning, COLORS.tokenReasoning));
    }
    lines.push("");

    // ── Billing summary (all steps) ─────────────────────────────────────────
    lines.push(`  ${fgBold(COLORS.header, t("billing.all_steps"))}  ${fg(COLORS.muted, `(${stepNum} ${t("billing.steps_label")})}`)}`);
    lines.push("");

    // Fresh input vs cache reused (the key distinction)
    const efficiencyColor =
      m.overall_cache_efficiency >= 80 ? "green" :
      m.overall_cache_efficiency >= 50 ? "yellow" : "red";

    lines.push(
      `  ${fg(COLORS.muted, t("billing.fresh_input") + ":")}  ` +
      fgBold(COLORS.tokenInput, fmtTokens(m.total_fresh_input)) +
      `  ${fg(COLORS.muted, t("billing.real_cost"))}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.cache_reused") + ":")} ` +
      fgBold(COLORS.tokenCache, fmtTokens(m.total_cache_reused)) +
      `  ${fg(COLORS.muted, t("billing.reused_free"))}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.cache_efficiency") + ":")} ` +
      fgBold(efficiencyColor, fmtPercent(m.overall_cache_efficiency)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.total_output") + ":")}  ` +
      fg(COLORS.tokenOutput, fmtTokens(m.tokens.output)),
    );
    lines.push("");

    // Timing
    lines.push(`  ${fg(COLORS.muted, t("session.duration") + ":")}  ` +
      fgBold("white", fmtDuration(m.duration_total_ms)) +
      `  ${fg(COLORS.muted, "(model: " + fmtDuration(m.duration_model_ms) + ")")}`);

    // Cost
    lines.push(`  ${fg(COLORS.muted, t("session.cost") + ":")}      ` +
      fg(m.cost === 0 ? "green" : "white", fmtCost(m.cost)));

    // Steps / tool calls with shortcut hints
    lines.push("");
    lines.push(
      `  ${fg(COLORS.muted, t("session.steps") + ":")}  ` +
      fg("cyan", `${m.step_count}`) +
      `  ${fg(COLORS.keyHint, "[S]")}` +
      `  ${fg(COLORS.muted, t("session.tool_calls") + ":")} ` +
      fg("cyan", `${m.tool_calls_count}`) +
      `  ${fg(COLORS.keyHint, "[T]")}`,
    );

    if (m.subagent_details.length > 0) {
      lines.push(
        `  ${fg(COLORS.muted, t("context.subagents") + ":")} ` +
        fg("cyan", `${m.subagent_details.length}`) +
        `  ${fg(COLORS.keyHint, "[A]")}`,
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
    const limit = m.context_limit;
    const peak = m.peak_turn_tokens;

    // ── Header ─────────────────────────────────────────────────────────────
    lines.push("");
    lines.push(`  ${fgBold(COLORS.header, t("context.header"))}`);
    lines.push(
      `  ${fgBold("white", shortModelId(m.model_id))} · ` +
      `${fg("white", fmtTokens(m.peak_context_tokens, true))}/${fmtTokens(limit, true)} ` +
      `(${fg(gaugeColor(m.context_percentage), `${m.context_percentage}%`)})`,
    );
    lines.push(`  ${fg(COLORS.muted, t("context.peak_label"))}`);
    lines.push("");

    // ── Peak context window breakdown ───────────────────────────────────────
    const newInputPct = limit > 0 ? (peak.input       / limit) * 100 : 0;
    const convPct     = limit > 0 ? (peak.cache_read   / limit) * 100 : 0;
    const outputPct   = limit > 0 ? (peak.output       / limit) * 100 : 0;
    const freePct     = limit > 0 ? Math.max(0, ((limit - m.peak_context_tokens) / limit) * 100) : 100;

    const BAR = 16;

    const renderRow = (
      symbol: string,
      label: string,
      pctVal: number,
      tokenCount: number,
      color: string,
    ) => {
      const bar    = asciiBar(pctVal, BAR, color, "black");
      const pctStr = fg(color, pad(fmtPercent(pctVal), 7, true));
      const cnt    = fg(COLORS.muted, fmtTokens(tokenCount, true) + " tokens");
      return `  ${fg(color, symbol)} ${pad(truncate(label, 14), 14)} ${bar} ${pctStr} ${cnt}`;
    };

    lines.push(renderRow("■", t("context.new_input"),    newInputPct, peak.input,                        COLORS.compUserText));
    if (peak.cache_read > 0) {
      lines.push(renderRow("■", t("context.conversation"), convPct,    peak.cache_read,                    COLORS.compConversation));
    }
    if (peak.output > 0) {
      lines.push(renderRow("■", t("tokens.output"),        outputPct,  peak.output,                        COLORS.tokenOutput));
    }
    lines.push(renderRow("░", t("context.free_space"),    freePct,    limit - m.peak_context_tokens, COLORS.compFreeSpace));

    // ── Initial input composition estimate ──────────────────────────────────
    const hasComposition =
      comp.system_prompt_tokens > 0 ||
      comp.auto_context_tokens > 0 ||
      comp.user_text_tokens > 0;

    if (hasComposition) {
      lines.push("");
      lines.push(`  ${fg(COLORS.muted, t("context.initial_composition"))}`);

      const coldTotal = comp.system_prompt_tokens + comp.auto_context_tokens + comp.user_text_tokens;
      const renderSubRow = (label: string, count: number, color: string) => {
        const subPct = coldTotal > 0 ? (count / coldTotal) * 100 : 0;
        const bar    = asciiBar(subPct, BAR, color, "black");
        const pctStr = fg(color, pad(fmtPercent(subPct), 7, true));
        const cnt    = fg(COLORS.muted, fmtTokens(count, true) + " tokens");
        return `  ${fg(COLORS.muted, "·")} ${pad(truncate(label, 14), 14)} ${bar} ${pctStr} ${cnt}`;
      };

      if (comp.system_prompt_tokens > 0) {
        lines.push(renderSubRow(t("context.system_prompt"), comp.system_prompt_tokens, "yellow"));
      }
      if (comp.auto_context_tokens > 0) {
        lines.push(renderSubRow(t("context.auto_context"), comp.auto_context_tokens, COLORS.compAutoContext));
      }
      if (comp.user_text_tokens > 0) {
        lines.push(renderSubRow(t("context.user_messages"), comp.user_text_tokens, COLORS.compUserText));
      }
    }

    // ── Auto-context warning ────────────────────────────────────────────────
    if (m.injected_diffs_count > 0) {
      lines.push("");
      lines.push(
        `  ${fg(COLORS.warning, "⚠")} ` +
        `${fg(COLORS.warning, `${m.injected_diffs_count} ${t("composition.diffs_injected")}`)}`
      );
    }

    // ── Subagents section ───────────────────────────────────────────────────
    if (m.subagents.length > 0) {
      lines.push("");
      lines.push(
        `  ${fgBold(COLORS.header, t("context.subagents"))}` +
        `  ${fg(COLORS.muted, `${m.subagents.length} ${t("context.tasks")}`)}`
      );

      m.subagents.forEach((sub, i) => {
        const isLast   = i === m.subagents.length - 1;
        const branch   = isLast ? "└" : "├";
        const agentColor =
          sub.agent_type === "explore" ? COLORS.subagentExplore :
          sub.agent_type === "general" ? COLORS.subagentGeneral :
          COLORS.subagentDefault;

        const subPct    = fg(gaugeColor(sub.context_percentage), `${sub.context_percentage}%`);
        const subTokens = fg(COLORS.muted, fmtTokens(sub.peak_tokens, true));
        const dur       = sub.duration_ms > 0 ? fg(COLORS.muted, ` ${fmtDuration(sub.duration_ms)}`) : "";
        const desc      = truncate(sub.description, 16);

        lines.push(
          `  ${fg(COLORS.muted, branch)} ${fg(agentColor, "@" + sub.agent_type)}` +
          `  ${fg("white", desc)}` +
          `  ${subTokens} ${subPct}${dur}`
        );
      });

      if (m.subagent_details.length > 0) {
        lines.push(`  ${fg(COLORS.keyHint, "[A]")} ${fg(COLORS.muted, t("context.subagents_hint"))}`);
      }
    }

    // ── Session metadata ────────────────────────────────────────────────────
    lines.push("");
    lines.push(`  ${fg(COLORS.muted, "─".repeat(22))}`);
    lines.push(`  ${fg(COLORS.muted, "Created")}  ${fg("white", fmtTimestamp(m.session.time_created))}`);
    lines.push(`  ${fg(COLORS.muted, "Updated")}  ${fg("white", fmtTimeAgo(m.session.time_updated))}`);
    lines.push(
      `  ${fg(COLORS.muted, "Files \u0394")}  ${fg("cyan", `+${m.session.summary_additions ?? 0}`)}` +
      `  ${fg("magenta", `-${m.session.summary_deletions ?? 0}`)}`,
    );

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
        icon = "◆"; color = COLORS.timelineSessionCreated;
        label = truncate(event.label, 45);
        break;
      case "message-sent":
        icon = "→"; color = COLORS.timelineMessageSent;
        label = t("timeline.message_sent");
        break;
      case "step-start":
        icon = "▶"; color = COLORS.timelineStepStart;
        label = t("timeline.step_start");
        break;
      case "step-finish":
        icon = "■"; color = COLORS.timelineStepFinish;
        label = t("timeline.step_finish");
        break;
      case "model-response":
        icon = "✓"; color = COLORS.timelineModelResponse;
        label = t("timeline.model_response");
        break;
      case "tool-call":
        icon = "⚙"; color = COLORS.timelineToolCall;
        label = t("timeline.tool_call");
        break;
      case "patch":
        icon = "⊕"; color = COLORS.timelinePatch;
        label = t("timeline.patch");
        break;
    }

    const detail = event.detail ? `  ${fg(COLORS.muted, event.detail)}` : "";
    return `  ${elapsed}  ${fg(color, icon)}  ${fg(color, label)}${detail}`;
  }

  // ─── Steps Overlay ─────────────────────────────────────────────────────────

  private renderStepsOverlay(steps: IStepMetrics[], _contextLimit: number): void {
    if (steps.length === 0) {
      this.stepsOverlay.setContent(`\n  ${fg(COLORS.muted, t("steps.no_steps"))}`);
      return;
    }

    const lines: string[] = [""];
    const totalSteps = steps.length;

    // Summary header
    lines.push(`  ${fgBold(COLORS.header, t("steps.title"))}  ${fg(COLORS.muted, `(${totalSteps} ${t("billing.steps_label")})}`)}`);
    lines.push("");

    // Aggregate billing summary at top
    const totalFresh  = steps.reduce((a, s) => a + s.tokens.input, 0);
    const totalCached = steps.reduce((a, s) => a + s.tokens.cache_read, 0);
    const totalOutput = steps.reduce((a, s) => a + s.tokens.output, 0);
    const overallEff  = totalFresh + totalCached > 0
      ? (totalCached / (totalFresh + totalCached)) * 100 : 0;

    lines.push(`  ${fg(COLORS.muted, t("billing.fresh_input") + ":")}  ${fgBold(COLORS.tokenInput, fmtTokens(totalFresh))}  ${fg(COLORS.muted, t("billing.real_cost"))}`);
    lines.push(`  ${fg(COLORS.muted, t("billing.cache_reused") + ":")} ${fgBold(COLORS.tokenCache, fmtTokens(totalCached))}  ${fg(COLORS.muted, t("billing.reused_free"))}`);
    lines.push(`  ${fg(COLORS.muted, t("billing.cache_efficiency") + ":")} ${fgBold(overallEff >= 80 ? "green" : overallEff >= 50 ? "yellow" : "red", fmtPercent(overallEff))}`);
    lines.push(`  ${fg(COLORS.muted, t("steps.context_range") + ":")} ${fg("white", fmtTokens(steps[0]!.tokens.total, true))} → ${fg("white", fmtTokens(steps[totalSteps - 1]!.tokens.total, true))}`);
    lines.push("");
    lines.push(`  ${fg(COLORS.muted, "─".repeat(60))}`);
    lines.push("");

    // Per-step entries
    for (const step of steps) {
      const isColdStart = step.step_number === 1;
      const isLastStep  = step.step_number === totalSteps;

      // Step header
      const stepLabel = `${t("steps.step")} ${step.step_number}/${totalSteps}`;
      const tag = isColdStart
        ? fg("yellow", `  [${t("steps.cold_start")}]`)
        : step.context_growth > 0
          ? fg(COLORS.muted, `  +${fmtTokens(step.context_growth, true)} tokens`)
          : "";
      const dur = step.duration_ms > 0 ? fg(COLORS.muted, fmtDuration(step.duration_ms)) : "";
      const finColor = step.finish_reason === "stop" ? "green" : "yellow";

      lines.push(
        `  ${fgBold("white", stepLabel)}${tag}` +
        `  ${fg(COLORS.muted, "dur:")} ${dur}` +
        `  ${fg(COLORS.muted, "finish:")} ${fg(finColor, step.finish_reason)}`,
      );

      // Context window bar for this step
      const ctxColor = gaugeColor(step.context_percentage);
      const ctxBar = asciiBar(step.context_percentage, 20, ctxColor, "black");
      lines.push(
        `  ${ctxBar} ${fgBold(ctxColor, `${step.context_percentage}%`)}` +
        `  ${fg(COLORS.muted, fmtTokens(step.tokens.total) + " / " + fmtTokens(step.context_limit))}`,
      );

      // Token breakdown
      const t_ = step.tokens;
      const total = t_.total;
      const inputPct  = total > 0 ? (t_.input      / total) * 100 : 0;
      const cachePct  = total > 0 ? (t_.cache_read / total) * 100 : 0;
      const outputPct = total > 0 ? (t_.output     / total) * 100 : 0;

      lines.push(
        `  ${fg(COLORS.tokenInput, "▪")} ${fg(COLORS.muted, t("tokens.input") + ":")} ${fgBold(COLORS.tokenInput, fmtTokens(t_.input))}` +
        `  ${fg(COLORS.muted, `(${fmtPercent(inputPct)})`)}`+
        `  ${fg(COLORS.muted, "—")} ` +
        `${fg("cyan", t("billing.real_cost"))}`,
      );

      if (t_.cache_read > 0 || !isColdStart) {
        const effColor = step.cache_efficiency >= 80 ? "green" : step.cache_efficiency >= 50 ? "yellow" : "red";
        const effBar = asciiBar(step.cache_efficiency, 16, effColor, "black");
        lines.push(
          `  ${fg(COLORS.tokenCache, "▪")} ${fg(COLORS.muted, t("tokens.cache_read") + ":")} ${fgBold(COLORS.tokenCache, fmtTokens(t_.cache_read))}` +
          `  ${fg(COLORS.muted, `(${fmtPercent(cachePct)})`)}` +
          `  ${fg(COLORS.muted, t("billing.reused_free"))}`,
        );
        lines.push(
          `  ${fg(COLORS.muted, "  " + t("steps.cache_efficiency") + ":")} ${effBar} ${fg(effColor, fmtPercent(step.cache_efficiency))}`,
        );
      } else {
        lines.push(`  ${fg("yellow", "  " + t("steps.cold_start_note"))}`);
      }

      lines.push(
        `  ${fg(COLORS.tokenOutput, "▪")} ${fg(COLORS.muted, t("tokens.output") + ":")} ${fg(COLORS.tokenOutput, fmtTokens(t_.output))}` +
        `  ${fg(COLORS.muted, `(${fmtPercent(outputPct)})`)}`,
      );

      if (t_.cache_write > 0) {
        lines.push(
          `  ${fg(COLORS.tokenCache, "▪")} ${fg(COLORS.muted, t("tokens.cache_write") + ":")} ${fg(COLORS.tokenCache, fmtTokens(t_.cache_write))}` +
          `  ${fg(COLORS.muted, t("steps.cached_for_next"))}`,
        );
      }

      // Tools used in this step
      if (step.tool_calls.length > 0) {
        const toolSummary = this.summarizeToolCalls(step.tool_calls);
        lines.push(`  ${fg(COLORS.muted, t("session.tool_calls") + ":")} ${fg(COLORS.timelineToolCall, toolSummary)}`);
      }

      // Separator (not after last step)
      if (!isLastStep) {
        lines.push(`  ${fg(COLORS.muted, "·".repeat(60))}`);
      }
      lines.push("");
    }

    // Final summary
    lines.push(`  ${fg(COLORS.muted, "─".repeat(60))}`);
    lines.push(`  ${fg(COLORS.muted, t("steps.growth_summary"))}  ` +
      `${fg("white", fmtTokens(steps[0]!.tokens.total, true))} → ` +
      `${fg("white", fmtTokens(steps[totalSteps - 1]!.tokens.total, true))} ` +
      `(${fg("cyan", "+" + fmtPercent(((steps[totalSteps - 1]!.tokens.total - steps[0]!.tokens.total) / steps[0]!.tokens.total) * 100))})`,
    );
    lines.push(`  ${fg(COLORS.muted, t("steps.avg_cache"))}  ${fg("green", fmtPercent(overallEff))}`);
    lines.push(`  ${fg(COLORS.muted, t("steps.total_output"))}  ${fg(COLORS.tokenOutput, fmtTokens(totalOutput))}`);
    lines.push("");
    lines.push(`  ${fg(COLORS.muted, "↑↓ / j k " + t("keys.scroll") + "  |  Escape " + t("keys.close"))}`);

    this.stepsOverlay.setContent(lines.join("\n"));
  }

  /** Returns a compact string like "bash(3), read(2), glob(1)" */
  private summarizeToolCalls(tools: IToolDetail[]): string {
    const counts = new Map<string, number>();
    for (const t of tools) {
      counts.set(t.tool_name, (counts.get(t.tool_name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");
  }

  // ─── Tools Overlay ─────────────────────────────────────────────────────────

  private renderToolsOverlay(tools: IToolDetail[], aggregations: IToolAggregation[]): void {
    const lines: string[] = [""];

    lines.push(`  ${fgBold(COLORS.header, t("tools.title"))}`);
    lines.push(`  ${fg(COLORS.muted, t("tools.total_calls") + ":")} ${fgBold("white", String(tools.length))}` +
      `  ${fg(COLORS.muted, t("tools.unique_tools") + ":")} ${fgBold("white", String(aggregations.length))}`);
    lines.push("");

    if (aggregations.length === 0) {
      lines.push(`  ${fg(COLORS.muted, t("tools.no_tools"))}`);
    } else {
      // ── Aggregation table ──────────────────────────────────────────────────
      lines.push(`  ${fgBold(COLORS.header, t("tools.summary"))}`);
      lines.push("");

      // Table header
      const col1 = 22; const col2 = 16; const col3 = 7; const col4 = 10; const col5 = 6;
      lines.push(
        `  ${fg(COLORS.muted, pad(t("tools.col_tool"),    col1))}` +
        `${fg(COLORS.muted, pad(t("tools.col_owner"),   col2))}` +
        `${fg(COLORS.muted, pad(t("tools.col_calls"),   col3, true))}` +
        `${fg(COLORS.muted, pad(t("tools.col_avgtime"), col4, true))}` +
        `${fg(COLORS.muted, pad(t("tools.col_errors"),  col5, true))}`,
      );
      lines.push(`  ${fg(COLORS.muted, "─".repeat(col1 + col2 + col3 + col4 + col5))}`);

      for (const agg of aggregations) {
        const errColor = agg.error_count > 0 ? "red" : COLORS.muted;
        lines.push(
          `  ${fg("white",         pad(agg.tool_name,                                col1))}` +
          `${fg(COLORS.muted,      pad(agg.tool_owner,                               col2))}` +
          `${fg("cyan",            pad(String(agg.total_calls),                      col3, true))}` +
          `${fg(COLORS.muted,      pad(agg.avg_duration_ms > 0 ? fmtDuration(agg.avg_duration_ms) : "—", col4, true))}` +
          `${fg(errColor,          pad(agg.error_count > 0 ? String(agg.error_count) : "—", col5, true))}`,
        );
      }

      lines.push("");
      lines.push(`  ${fg(COLORS.muted, "─".repeat(60))}`);
      lines.push("");

      // ── Recent calls (last 30) ─────────────────────────────────────────────
      const recent = [...tools].reverse().slice(0, 30);
      lines.push(`  ${fgBold(COLORS.header, t("tools.recent_calls"))} ${fg(COLORS.muted, `(last ${recent.length})`)}`);
      lines.push("");

      recent.forEach((tool, i) => {
        const idx = tools.length - i;
        const statusIcon = tool.has_error ? fg("red", "✗") : fg("green", "✓");
        const ownerTag = tool.tool_owner !== "Built-in"
          ? fg(COLORS.muted, ` [${tool.tool_owner}]`)
          : "";
        const dur = tool.duration_ms > 0 ? fg(COLORS.muted, ` ${fmtDuration(tool.duration_ms)}`) : "";

        lines.push(
          `  ${fg(COLORS.muted, `#${pad(String(idx), 3, true)}`)}` +
          ` ${statusIcon}` +
          ` ${fgBold("white", pad(tool.tool_name, 18))}` +
          `${ownerTag}${dur}`,
        );
        if (tool.title && tool.title !== tool.tool_name) {
          lines.push(`       ${fg(COLORS.muted, truncate(tool.title, 55))}`);
        }
      });
    }

    lines.push("");
    lines.push(`  ${fg(COLORS.muted, "↑↓ / j k " + t("keys.scroll") + "  |  Escape " + t("keys.close"))}`);

    this.toolsOverlay.setContent(lines.join("\n"));
  }

  // ─── Subagent Overlay ──────────────────────────────────────────────────────

  private renderSubagentOverlay(sub: ISubagentDetail, index: number, total: number): void {
    const lines: string[] = [""];

    const agentColor =
      sub.agent_type === "explore" ? COLORS.subagentExplore :
      sub.agent_type === "general" ? COLORS.subagentGeneral :
      COLORS.subagentDefault;

    // Header with position indicator
    const posIndicator = total > 1
      ? `  ${fg(COLORS.muted, `${index + 1}/${total}`)}  ${fg(COLORS.keyHint, "←→")} ${fg(COLORS.muted, "navigate")}`
      : "";
    lines.push(
      `  ${fgBold(COLORS.header, t("subagent.title"))}  ` +
      `${fgBold(agentColor, "@" + sub.agent_type)}${posIndicator}`,
    );
    lines.push(`  ${fg("white", sub.description)}`);
    lines.push("");
    lines.push(
      `  ${fg(COLORS.muted, t("session.model") + ":")} ${fg("white", shortModelId(sub.model_id))}` +
      `  ${fg(COLORS.muted, t("session.duration") + ":")} ${fg("white", fmtDuration(sub.duration_ms))}` +
      `  ${fg(COLORS.muted, t("session.cost") + ":")} ${fg("white", fmtCost(sub.cost))}`,
    );
    lines.push("");

    // ── Context vs Parent ──────────────────────────────────────────────────
    lines.push(`  ${fgBold(COLORS.header, t("subagent.context_vs_parent"))}`);
    lines.push(
      `  ${fg(COLORS.muted, t("subagent.shared_context") + ":")} ` +
      `${fgBold("yellow", fmtTokens(sub.shared_context_tokens))} ` +
      `${fg(COLORS.muted, t("subagent.shared_context_note"))}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("subagent.peak_context") + ":")} ` +
      `${fgBold(gaugeColor(sub.context_percentage), fmtTokens(sub.peak_tokens))}` +
      `  ${fg(gaugeColor(sub.context_percentage), `${sub.context_percentage}%`)}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("subagent.context_growth") + ":")} ` +
      `${fg("white", fmtTokens(sub.shared_context_tokens, true))} → ` +
      `${fg("white", fmtTokens(sub.peak_tokens, true))}`,
    );
    lines.push("");

    // ── Billing ────────────────────────────────────────────────────────────
    lines.push(`  ${fgBold(COLORS.header, t("billing.all_steps"))}`);
    const effColor = sub.cache_efficiency >= 80 ? "green" : sub.cache_efficiency >= 50 ? "yellow" : "red";
    lines.push(
      `  ${fg(COLORS.muted, t("billing.fresh_input") + ":")}  ` +
      `${fgBold(COLORS.tokenInput, fmtTokens(sub.tokens_billing.input))}  ${fg(COLORS.muted, t("billing.real_cost"))}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.cache_reused") + ":")} ` +
      `${fgBold(COLORS.tokenCache, fmtTokens(sub.tokens_billing.cache_read))}  ${fg(COLORS.muted, t("billing.reused_free"))}`,
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.cache_efficiency") + ":")} ` +
      `${fgBold(effColor, fmtPercent(sub.cache_efficiency))}`,
    );
    lines.push("");

    // ── Steps ──────────────────────────────────────────────────────────────
    lines.push(
      `  ${fgBold(COLORS.header, t("steps.title"))}  ` +
      `${fg(COLORS.muted, `(${sub.steps.length} ${t("billing.steps_label")})}`)}`
    );
    lines.push("");

    for (const step of sub.steps) {
      const isCold = step.step_number === 1;
      const ctxColor = gaugeColor(step.context_percentage);
      const ctxBar = asciiBar(step.context_percentage, 18, ctxColor, "black");

      const tag = isCold
        ? fg("yellow", ` [${t("steps.cold_start")}]`)
        : fg(COLORS.muted, ` +${fmtTokens(step.context_growth, true)}`);

      lines.push(
        `  ${fgBold("white", `${t("steps.step")} ${step.step_number}/${sub.steps.length}`)}${tag}` +
        `  ${fg(COLORS.muted, step.duration_ms > 0 ? fmtDuration(step.duration_ms) : "")}`,
      );
      lines.push(
        `  ${ctxBar} ${fg(ctxColor, `${step.context_percentage}%`)}` +
        `  ${fg(COLORS.muted, fmtTokens(step.tokens.total))}` +
        `  ${fg(COLORS.muted, t("tokens.input") + ":")} ${fg(COLORS.tokenInput, fmtTokens(step.tokens.input, true))}` +
        `  ${fg(COLORS.muted, t("tokens.cache_read") + ":")} ${fg(COLORS.tokenCache, fmtTokens(step.tokens.cache_read, true))}` +
        `  ${fg(COLORS.muted, "eff:")} ${fg(step.cache_efficiency >= 80 ? "green" : "yellow", fmtPercent(step.cache_efficiency))}`,
      );

      if (step.tool_calls.length > 0) {
        lines.push(`  ${fg(COLORS.muted, "   tools:")} ${fg(COLORS.timelineToolCall, this.summarizeToolCalls(step.tool_calls))}`);
      }
      lines.push("");
    }

    // ── Tools summary ──────────────────────────────────────────────────────
    if (sub.tools_aggregation.length > 0) {
      lines.push(`  ${fgBold(COLORS.header, t("tools.summary"))}`);
      lines.push("");

      for (const agg of sub.tools_aggregation) {
        const errStr = agg.error_count > 0 ? fg("red", ` ${agg.error_count} err`) : "";
        lines.push(
          `  ${fg("white", pad(agg.tool_name, 20))}` +
          `${fg(COLORS.muted, pad(agg.tool_owner, 16))}` +
          `${fg("cyan", pad(String(agg.total_calls), 5, true))} calls` +
          `${errStr}`,
        );
      }
      lines.push("");
    }

    lines.push(`  ${fg(COLORS.muted, "↑↓ / j k " + t("keys.scroll") + "  |  ←→ / h l navigate  |  Escape " + t("keys.close"))}`);

    this.subagentOverlay.setContent(lines.join("\n"));
  }

  // ─── Details Overlay ───────────────────────────────────────────────────────

  private renderDetailsOverlay(m: ISessionMetrics): void {
    const lines: string[] = [""];

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

    // Token billing totals (sum across all steps)
    lines.push(`  ${fgBold(COLORS.header, t("details.raw_tokens"))} ${fg(COLORS.muted, "(billing — all steps)")}`);
    lines.push(`  ${fg(COLORS.muted, "total")}        ${fg("white", fmtTokens(m.tokens.total))}`);
    lines.push(`  ${fg(COLORS.muted, "input")}        ${fg(COLORS.tokenInput, fmtTokens(m.tokens.input))}`);
    lines.push(`  ${fg(COLORS.muted, "output")}       ${fg(COLORS.tokenOutput, fmtTokens(m.tokens.output))}`);
    lines.push(`  ${fg(COLORS.muted, "reasoning")}    ${fg(COLORS.tokenReasoning, fmtTokens(m.tokens.reasoning))}`);
    lines.push(`  ${fg(COLORS.muted, "cache.read")}   ${fg(COLORS.tokenCache, fmtTokens(m.tokens.cache_read))}`);
    lines.push(`  ${fg(COLORS.muted, "cache.write")}  ${fg(COLORS.tokenCache, fmtTokens(m.tokens.cache_write))}`);
    lines.push("");

    // Breakdown (real cost vs cache)
    lines.push(`  ${fgBold(COLORS.header, t("billing.breakdown"))}`);
    lines.push(`  ${fg(COLORS.muted, t("billing.fresh_input") + ":")}  ${fgBold(COLORS.tokenInput, fmtTokens(m.total_fresh_input))}`);
    lines.push(`  ${fg(COLORS.muted, t("billing.cache_reused") + ":")} ${fgBold(COLORS.tokenCache, fmtTokens(m.total_cache_reused))}`);
    lines.push(`  ${fg(COLORS.muted, t("billing.cache_efficiency") + ":")} ${fg("green", fmtPercent(m.overall_cache_efficiency))}`);
    lines.push("");

    // Context window
    lines.push(`  ${fgBold(COLORS.header, t("context.limit"))}:  ${fg("white", fmtTokens(m.context_limit))}`);
    lines.push(`  ${fgBold(COLORS.header, "Peak turn")}:  ${fg(gaugeColor(m.context_percentage), m.context_percentage + "%")}  (${fmtTokens(m.peak_context_tokens)})`);
    lines.push(`  ${fgBold(COLORS.header, "Last step")}:  ${fg(gaugeColor(m.last_step_context_percentage), m.last_step_context_percentage + "%")}  (${fmtTokens(m.last_step_tokens.total)})`);
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
    lines.push(`  ${fgBold(COLORS.header, "Token Composition")} ${fg(COLORS.muted, "(estimated, cold turn)")}`);
    lines.push(`  ${fg(COLORS.muted, "auto-context")}:   ${fg(COLORS.compAutoContext, fmtTokens(m.token_composition.auto_context_tokens))}`);
    lines.push(`  ${fg(COLORS.muted, "system prompt")}:  ${fg("yellow", fmtTokens(m.token_composition.system_prompt_tokens))}`);
    lines.push(`  ${fg(COLORS.muted, "user text")}:      ${fg(COLORS.compUserText, fmtTokens(m.token_composition.user_text_tokens))}`);
    lines.push("");

    lines.push(`  ${fg(COLORS.muted, "Press ")}${fgBold("white", "Escape")}${fg(COLORS.muted, " or ")}${fgBold("white", "D")}${fg(COLORS.muted, " to close")}`);

    this.detailsOverlay.setContent(lines.join("\n"));
  }

  // ─── Settings Overlay ──────────────────────────────────────────────────────

  private renderSettingsOverlay(): void {
    this.settingsOverlay.setContent("");

    const langEn = this.config.language === "en";
    const en = blessed.radiobutton({
      parent: this.settingsOverlay,
      top: 2, left: 3,
      content: "English",
      checked: langEn, mouse: true,
      style: { fg: "white" },
    });

    const ptBr = blessed.radiobutton({
      parent: this.settingsOverlay,
      top: 4, left: 3,
      content: "Português Brasileiro",
      checked: !langEn, mouse: true,
      style: { fg: "white" },
    });

    const label = blessed.text({
      parent: this.settingsOverlay,
      top: 1, left: 2,
      content: fgBold(COLORS.header, t("settings.language")),
      tags: true,
    });

    const sep = blessed.text({
      parent: this.settingsOverlay,
      top: 6, left: 2,
      content: fg(COLORS.muted, "─".repeat(40)),
      tags: true,
    });

    const refreshLabel = blessed.text({
      parent: this.settingsOverlay,
      top: 7, left: 2,
      content: fgBold(COLORS.header, t("settings.refresh_interval")),
      tags: true,
    });

    const refreshOptions = [1, 2, 5, 10];
    let selectedRefresh = refreshOptions.indexOf(this.config.refreshInterval);
    if (selectedRefresh < 0) selectedRefresh = 1;

    const refreshRadios = refreshOptions.map((sec, i) =>
      blessed.radiobutton({
        parent: this.settingsOverlay,
        top: 8, left: 3 + i * 7,
        content: `${sec}s`,
        checked: i === selectedRefresh,
        mouse: true,
        style: { fg: "white" },
      }),
    );

    const saveBtn = blessed.button({
      parent: this.settingsOverlay,
      top: 11, left: 3, width: 12, height: 3,
      content: `  ${t("settings.save")}  `,
      tags: true, border: { type: "line" }, mouse: true, keys: true,
      style: { fg: "black", bg: "green", border: { fg: "green" }, focus: { bg: "white" }, hover: { bg: "white" } },
    });

    const cancelBtn = blessed.button({
      parent: this.settingsOverlay,
      top: 11, left: 18, width: 14, height: 3,
      content: `  ${t("settings.cancel")}  `,
      tags: true, border: { type: "line" }, mouse: true, keys: true,
      style: { fg: "white", bg: "black", border: { fg: "gray" }, focus: { bg: "gray" }, hover: { bg: "gray" } },
    });

    const hintText = blessed.text({
      parent: this.settingsOverlay,
      top: 15, left: 2,
      content: fg(COLORS.muted, "ESC to cancel"),
      tags: true,
    });

    void label; void sep; void refreshLabel; void hintText;

    saveBtn.on("press", () => {
      const lang = en.checked ? "en" : ("pt-BR" as const);
      const refreshIdx = refreshRadios.findIndex((r) => r.checked);
      const refreshSec = refreshOptions[refreshIdx >= 0 ? refreshIdx : 1] ?? 2;

      this.config.language = lang;
      this.config.refreshInterval = refreshSec;
      setLanguage(lang);
      saveConfig(this.config);

      this.updatePanelLabels();
      this.onRefreshRequest?.();

      this.hideSettings();
      this.renderFooter();
    });

    cancelBtn.on("press", () => { this.hideSettings(); });

    this.screen.render();
  }

  private renderFooter(): void {
    const sep = fg(COLORS.muted, " │ ");
    const hint = (key: string, label: string) =>
      `${fgBold(COLORS.keyHint, key)} ${fg(COLORS.keyLabel, label)}`;

    const line =
      ` ${hint("↑↓", t("keys.navigate"))}` +
      sep + hint("D", t("keys.details")) +
      sep + hint("S", t("keys.steps")) +
      sep + hint("T", t("keys.tools")) +
      sep + hint("A", t("keys.subagents")) +
      sep + hint("C", t("keys.settings")) +
      sep + hint("R", t("keys.refresh")) +
      sep + hint("Q", t("keys.quit"));

    this.footerBox.setContent(`\n${line}`);
  }

  private updatePanelLabels(): void {
    this.sessionListBox.options.label = ` ${t("panel.sessions")} `;
    this.contextBox.options.label = ` ${t("panel.context")} `;
    this.tokenBox.options.label = ` ${t("panel.composition")} `;
    this.timelineBox.options.label = ` ${t("panel.timeline")} `;
    this.stepsOverlay.options.label = ` ${t("panel.steps")} `;
    this.toolsOverlay.options.label = ` ${t("panel.tools")} `;
    this.subagentOverlay.options.label = ` ${t("panel.subagent")} `;
  }

  // Silence the unused variable warnings for `bold`
  private _unusedBold = bold;
}
