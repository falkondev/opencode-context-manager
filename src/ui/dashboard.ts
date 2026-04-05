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
const SESSION_LIST_WIDTH = "25%";

// ─── Dashboard ────────────────────────────────────────────────────────────────

export class Dashboard {
  private screen: Widgets.Screen;
  private config: IAppConfig;

  // Panels
  private sessionBox!: Widgets.BoxElement;
  private searchBox!: Widgets.BoxElement;
  private contextBox!: Widgets.BoxElement;
  private timelineBox!: Widgets.BoxElement;
  private footerBox!: Widgets.BoxElement;
  private headerBox!: Widgets.BoxElement;

  // Overlays
  private detailsOverlay!: Widgets.BoxElement;
  private settingsOverlay!: Widgets.BoxElement;
  private stepsOverlay!: Widgets.BoxElement;
  private toolsOverlay!: Widgets.BoxElement;
  private subagentOverlay!: Widgets.BoxElement;
  private renameOverlay!: Widgets.BoxElement;
  private renameInput!: Widgets.TextboxElement;

  // State
  private summaries: ISessionSummary[] = [];
  private filteredSummaries: ISessionSummary[] = [];
  private currentMetrics: ISessionMetrics | null = null;
  private selectedIndex = 0;
  private detailsVisible = false;
  private settingsVisible = false;
  private stepsVisible = false;
  private toolsVisible = false;
  private subagentVisible = false;
  private renameVisible = false;
  private selectedSubagentIndex = 0;
  private onSelectSession: ((id: string) => void) | null = null;
  private onRefreshRequest: (() => void) | null = null;
  private onRenameSessionRequest: ((id: string, newTitle: string) => boolean) | null = null;

  // Search state
  private searchActive = false;
  private searchQuery = "";

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

  public onRename(cb: (id: string, newTitle: string) => boolean): void {
    this.onRenameSessionRequest = cb;
  }

  public update(summaries: ISessionSummary[], current: ISessionMetrics | null): void {
    this.summaries = summaries;
    this.currentMetrics = current;
    this.applyFilter();

    this.renderSessionArea();
    this.renderContextPanel();
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
      style: { fg: COLORS.header, bg: "#000000", bold: true },
    });

    // Search bar (above session list)
    this.searchBox = blessed.box({
      top: 3,
      left: 0,
      width: SESSION_LIST_WIDTH,
      height: 3,
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: COLORS.border },
        fg: "white",
        bg: "#000000",
      },
    });

    // Session list (left) — custom rendered box with 2 lines per session
    this.sessionBox = blessed.box({
      top: 6,
      left: 0,
      width: SESSION_LIST_WIDTH,
      height: "75%-6",
      label: ` ${t("panel.sessions")} `,
      tags: true,
      border: { type: "line" },
      scrollable: true,
      alwaysScroll: true,
      wrap: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scrollbar: { ch: "│" } as any,
      mouse: true,
      keys: true,
      style: {
        border: { fg: COLORS.border },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.title } as any,
        fg: "white",
        bg: "#000000",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scrollbar: { bg: COLORS.border } as any,
      },
    });

    // Context panel — occupies remaining 75% width
    this.contextBox = blessed.box({
      top: 3,
      left: SESSION_LIST_WIDTH,
      width: `${100 - 25}%`,
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
        bg: "#000000",
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
        bg: "#000000",
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
      style: { fg: COLORS.footerText, bg: "#000000" },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.searchBox);
    this.screen.append(this.sessionBox);
    this.screen.append(this.contextBox);
    this.screen.append(this.timelineBox);
    this.screen.append(this.footerBox);

    this.renderSearchBox();
    this.renderFooter();
    this.sessionBox.focus();
  }

  private buildOverlays(): void {
    const overlayBase = {
      tags: true,
      border: { type: "line" as const },
      scrollable: true,
      alwaysScroll: true,
      wrap: false,
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
        bg: "#000000",
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
        bg: "#000000",
      },
    });

    this.screen.append(this.detailsOverlay);
    this.screen.append(this.stepsOverlay);
    this.screen.append(this.toolsOverlay);
    this.screen.append(this.subagentOverlay);
    this.screen.append(this.settingsOverlay);

    // Rename overlay — small centered dialog with a textbox
    this.renameOverlay = blessed.box({
      top: "center",
      left: "center",
      width: 60,
      height: 7,
      label: ` ${t("rename.title")} `,
      tags: true,
      border: { type: "line" },
      keys: true,
      mouse: true,
      hidden: true,
      style: {
        border: { fg: COLORS.header },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        label: { fg: COLORS.header, bold: true } as any,
        fg: "white",
        bg: "#000000",
      },
    });

    this.renameInput = blessed.textbox({
      parent: this.renameOverlay,
      top: 1,
      left: 1,
      width: "100%-4",
      height: 3,
      inputOnFocus: true,
      keys: true,
      mouse: true,
      tags: false,
      border: { type: "line" },
      style: {
        border: { fg: COLORS.border },
        fg: "white",
        bg: "#000000",
        focus: { border: { fg: COLORS.header } },
      },
    });

    this.screen.append(this.renameOverlay);
  }

  // ─── Key / Mouse Bindings ──────────────────────────────────────────────────

  private bindKeys(): void {
    // Quit
    this.screen.key(["q", "Q", "C-c"], () => {
      if (this.searchActive) return;
      this.destroy();
      process.exit(0);
    });

    // Refresh
    this.screen.key(["r", "R"], () => {
      if (this.searchActive) return;
      this.onRefreshRequest?.();
    });

    // Technical details toggle
    this.screen.key(["d", "D"], () => {
      if (this.searchActive) return;
      this.closeAllOverlays();
      this.toggleDetails();
    });

    // Settings toggle
    this.screen.key(["c", "C"], () => {
      if (this.searchActive) return;
      this.closeAllOverlays();
      this.toggleSettings();
    });

    // Steps overlay toggle
    this.screen.key(["s", "S"], () => {
      if (this.searchActive) return;
      this.closeAllOverlays();
      this.toggleSteps();
    });

    // Tools overlay toggle
    this.screen.key(["t", "T"], () => {
      if (this.searchActive) return;
      this.closeAllOverlays();
      this.toggleTools();
    });

    // Subagents overlay toggle
    this.screen.key(["a", "A"], () => {
      if (this.searchActive) return;
      this.closeAllOverlays();
      this.toggleSubagent();
    });

    // Rename session (N key)
    this.screen.key(["n", "N"], () => {
      if (this.searchActive) return;
      if (this.anyOverlayVisible()) return;
      this.openRename();
    });

    // Activate search with "/"
    this.screen.key(["/"], () => {
      if (this.anyOverlayVisible()) return;
      this.activateSearch();
    });

    // Navigate sessions — bind keys on the session box
    this.sessionBox.key(["up", "k"], () => {
      if (this.anyOverlayVisible()) return;
      this.navigateSession(-1);
    });
    this.sessionBox.key(["down", "j"], () => {
      if (this.anyOverlayVisible()) return;
      this.navigateSession(1);
    });

    // Session box mouse click
    this.sessionBox.on("click", (data) => {
      if (this.anyOverlayVisible()) return;
      // Each session takes 2 lines; offset 1 for the border
      const relY = data.y - (this.sessionBox as unknown as { atop: number }).atop - 1;
      const clickedIndex = Math.floor(relY / 2);
      if (clickedIndex >= 0 && clickedIndex < this.filteredSummaries.length) {
        this.selectedIndex = clickedIndex;
        const s = this.filteredSummaries[clickedIndex];
        if (s) this.onSelectSession?.(s.id);
        this.renderSessionArea();
        this.screen.render();
      }
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

  // ─── Search ────────────────────────────────────────────────────────────────

  private activateSearch(): void {
    this.searchActive = true;
    this.renderSearchBox();
    this.screen.render();

    // Capture raw keypresses while search is active
    const onKeypress = (_ch: string | undefined, key: { name: string; sequence: string }) => {
      if (!this.searchActive) return;

      if (key.name === "escape") {
        this.searchQuery = "";
        this.searchActive = false;
        this.applyFilter();
        this.renderSearchBox();
        this.renderSessionArea();
        this.screen.render();
        this.screen.removeListener("keypress", onKeypress);
        return;
      }

      if (key.name === "enter" || key.name === "return") {
        this.searchActive = false;
        this.renderSearchBox();
        this.screen.render();
        this.screen.removeListener("keypress", onKeypress);
        return;
      }

      if (key.name === "backspace") {
        this.searchQuery = this.searchQuery.slice(0, -1);
      } else if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
        this.searchQuery += key.sequence;
      }

      this.applyFilter();
      this.renderSearchBox();
      this.renderSessionArea();
      this.screen.render();
    };

    this.screen.on("keypress", onKeypress);
  }

  private applyFilter(): void {
    if (!this.searchQuery) {
      this.filteredSummaries = [...this.summaries];
    } else {
      const q = this.searchQuery.toLowerCase();
      this.filteredSummaries = this.summaries.filter((s) =>
        s.title.toLowerCase().includes(q) ||
        s.directory.toLowerCase().includes(q) ||
        s.model_id.toLowerCase().includes(q),
      );
    }

    // Clamp selectedIndex
    if (this.selectedIndex >= this.filteredSummaries.length) {
      this.selectedIndex = Math.max(0, this.filteredSummaries.length - 1);
    }
  }

  private renderSearchBox(): void {
    const borderColor = this.searchActive ? COLORS.header : COLORS.border;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.searchBox.style as any).border = { fg: borderColor };

    if (this.searchActive) {
      const cursor = fg(COLORS.header, "█");
      const query = this.searchQuery
        ? fgBold("white", this.searchQuery)
        : fg(COLORS.muted, t("search.placeholder"));
      this.searchBox.setContent(` ${fg(COLORS.keyHint, "/")} ${query}${cursor}`);
    } else if (this.searchQuery) {
      this.searchBox.setContent(
        ` ${fg(COLORS.keyHint, "/")} ${fgBold("white", this.searchQuery)}` +
        `  ${fg(COLORS.muted, t("search.clear"))}`,
      );
    } else {
      this.searchBox.setContent(` ${fg(COLORS.muted, t("search.placeholder"))}`);
    }
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  private navigateSession(delta: number): void {
    if (this.filteredSummaries.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.filteredSummaries.length - 1, this.selectedIndex + delta),
    );
    const s = this.filteredSummaries[this.selectedIndex];
    if (s) this.onSelectSession?.(s.id);
    this.renderSessionArea();
    this.screen.render();
  }

  // ─── Overlay Management ────────────────────────────────────────────────────

  private anyOverlayVisible(): boolean {
    return (
      this.detailsVisible ||
      this.settingsVisible ||
      this.stepsVisible ||
      this.toolsVisible ||
      this.subagentVisible ||
      this.renameVisible
    );
  }

  private closeAllOverlays(): void {
    if (this.detailsVisible) this.hideDetails();
    if (this.settingsVisible) this.hideSettings();
    if (this.stepsVisible) this.hideSteps();
    if (this.toolsVisible) this.hideTools();
    if (this.subagentVisible) this.hideSubagent();
    if (this.renameVisible) this.closeRename();
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
    this.sessionBox.focus();
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
    this.sessionBox.focus();
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
    this.sessionBox.focus();
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
    this.sessionBox.focus();
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
    this.sessionBox.focus();
    this.screen.render();
  }

  // ─── Rename Overlay ─────────────────────────────────────────────────────────

  private openRename(): void {
    const s = this.filteredSummaries[this.selectedIndex];
    if (!s) return;

    this.renameVisible = true;

    // Build hint text below the input
    const hint = fg(COLORS.muted, `${t("rename.hint_enter")}  ${t("rename.hint_escape")}`);
    this.renameOverlay.setContent(`\n\n\n\n ${hint}`);

    // Pre-fill the input with the current session title
    this.renameInput.setValue(s.title);
    this.renameOverlay.show();
    this.renameInput.focus();
    this.screen.render();

    // Handle submission — fires when user presses Enter inside the textbox
    const onSubmit = (value: string) => {
      this.renameInput.removeAllListeners("submit");
      this.renameInput.removeAllListeners("cancel");
      const trimmed = value.trim();
      if (trimmed && trimmed !== s.title) {
        this.onRenameSessionRequest?.(s.id, trimmed);
      }
      this.closeRename();
    };

    const onCancel = () => {
      this.renameInput.removeAllListeners("submit");
      this.renameInput.removeAllListeners("cancel");
      this.closeRename();
    };

    this.renameInput.once("submit", onSubmit);
    this.renameInput.once("cancel", onCancel);
  }

  private closeRename(): void {
    this.renameVisible = false;
    this.renameOverlay.hide();
    this.sessionBox.focus();
    this.screen.render();
  }

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

  // ─── Session Area (search + custom list) ──────────────────────────────────

  private renderSessionArea(): void {
    this.renderSearchBox();
    this.renderSessionList();
  }

  private renderSessionList(): void {
    if (this.filteredSummaries.length === 0) {
      const msg = this.searchQuery
        ? fg(COLORS.muted, t("search.no_results"))
        : fg(COLORS.muted, t("app.no_sessions"));
      this.sessionBox.setContent(`\n  ${msg}`);
      return;
    }

    // Inner width of the box (subtract 2 for the borders)
    const boxWidth = Math.max(10, Math.floor((this.screen.width as number) * 0.25) - 2);

    const lines: string[] = [];

    this.filteredSummaries.forEach((s, i) => {
      const isSelected = i === this.selectedIndex;
      const liveIcon = s.is_live ? fg(COLORS.live, "⬤") : fg(COLORS.muted, "·");

      // Pct label
      const pctStr = s.has_data
        ? fg(gaugeColor(s.context_percentage), `${s.context_percentage}%`)
        : fg(COLORS.muted, "—");

      // Title — truncate so title + space + pct fits in boxWidth
      const pctRaw = s.has_data ? `${s.context_percentage}%` : "—";
      const titleMaxLen = boxWidth - pctRaw.length - 5; // 1 space + 1 liveIcon + 1 space + 2 spaces before pct
      const titleStr = truncate(s.title, Math.max(6, titleMaxLen));

      // Model + tokens + age — second line
      const modelStr = truncate(shortModelId(s.model_id), 10);
      const tokensStr = s.has_data ? fmtTokens(s.total_tokens, true) : "—";
      const ageStr = fmtTimeAgo(s.time_created);

      // Build lines with optional blue-bg tag for selection
      if (isSelected) {
        // Compute plain-text lengths (without blessed tags) so we can pad to boxWidth
        const plain1 = ` * ${titleStr}  ${pctRaw}`;
        const plain2 = `   ${modelStr}  ${tokensStr}  ${ageStr}`;
        const fill1 = " ".repeat(Math.max(0, boxWidth - plain1.length));
        const fill2 = " ".repeat(Math.max(0, boxWidth - plain2.length));
        const line1 = `{blue-bg} ${liveIcon} ${fgBold("white", titleStr)}  ${pctStr}${fill1}{/blue-bg}`;
        const line2 = `{blue-bg}   ${fg(COLORS.muted, modelStr)}  ${fg(COLORS.muted, tokensStr)}  ${fg(COLORS.muted, ageStr)}${fill2}{/blue-bg}`;
        lines.push(line1);
        lines.push(line2);
      } else {
        const line1 = ` ${liveIcon} ${fg("white", titleStr)}  ${pctStr}`;
        const line2 = `   ${fg(COLORS.muted, modelStr)}  ${fg(COLORS.muted, tokensStr)}  ${fg(COLORS.muted, ageStr)}`;
        lines.push(line1);
        lines.push(line2);
      }
    });

    this.sessionBox.setContent(lines.join("\n"));

    // Scroll to show selected item (2 lines per item)
    const scrollTarget = this.selectedIndex * 2;
    this.sessionBox.scrollTo(scrollTarget);
  }

  private renderContextPanel(): void {
    const m = this.currentMetrics;
    if (!m) {
      this.contextBox.setContent(`\n  ${fg(COLORS.muted, t("session.no_data"))}`);
      return;
    }

    const lines: string[] = [];

    // ── Session identity ───────────────────────────────────────────────────
    lines.push("");
    lines.push(`  ${fgBold(COLORS.header, truncate(m.session.title, 50))}`);
    lines.push(`  ${fg(COLORS.muted, shortDir(m.session.directory))}`);
    lines.push("");

    // Model / agent / finish row
    lines.push(
      `  ${fg(COLORS.muted, t("session.model") + ":")}  ` +
      fgBold("white", shortModelId(m.model_id)) +
      `  ${fg(COLORS.muted, t("session.agent") + ":")} ` +
      fg("cyan", m.agent) +
      `  ${fg(COLORS.muted, t("session.finish") + ":")} ` +
      fg(m.finish_reason === "stop" ? "green" : "yellow", m.finish_reason),
    );
    lines.push("");

    // ── Context Window ─────────────────────────────────────────────────────
    lines.push(`  ${fgBold(COLORS.header, "── " + t("context.current_window") + " ──")}`);

    const lastPct = m.last_step_context_percentage;
    const lastTokens = m.last_step_tokens;
    const lastColor = gaugeColor(lastPct);
    const freeTokens = m.context_limit - lastTokens.total;

    const lastBar = asciiBar(lastPct, BAR_WIDTH, lastColor, "#000000");
    const lastPctLabel = fgBold(lastColor, `${lastPct}%`);
    lines.push(
      `  ${lastBar}  ${lastPctLabel}  ${fg(COLORS.muted, "|")}  ` +
      `${fg(COLORS.muted, fmtTokens(lastTokens.total) + " / " + fmtTokens(m.context_limit))}  ${fg(COLORS.muted, "|")}  ` +
      `${fg(COLORS.muted, fmtTokens(freeTokens) + " " + t("misc.free"))}`,
    );
    lines.push("");

    // ── Billing (all steps) ────────────────────────────────────────────────
    const stepNum = m.step_count;
    lines.push(
      `  ${fgBold(COLORS.header, "── " + t("billing.all_steps") + " ──")}` +
      `  ${fg(COLORS.muted, `(${stepNum} ${t("billing.steps_label")})`)}`,
    );

    const efficiencyColor =
      m.overall_cache_efficiency >= 80 ? "green" :
      m.overall_cache_efficiency >= 50 ? "yellow" : "red";

    lines.push(
      `  ${fg(COLORS.muted, t("billing.fresh_input") + ":")}    ` +
      fgBold(COLORS.tokenInput, fmtTokens(m.total_fresh_input)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.cache_reused") + ":")}   ` +
      fgBold(COLORS.tokenCache, fmtTokens(m.total_cache_reused)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.total_output") + ":")}    ` +
      fg(COLORS.tokenOutput, fmtTokens(m.tokens.output)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("billing.cache_efficiency") + ":")} ` +
      fgBold(efficiencyColor, fmtPercent(m.overall_cache_efficiency)),
    );
    lines.push("");

    // ── Window Composition (estimated) ────────────────────────────────────
    const comp = m.token_composition;
    const systemTokens = comp.system_prompt_tokens;
    // Conversation = cache_read of last step (what the model "saw" from history)
    const convTokens = lastTokens.cache_read;
    // Buffer = auto-context injected files
    const bufferTokens = comp.auto_context_tokens;

    lines.push(`  ${fgBold(COLORS.header, "── " + t("context.window_composition") + " ──")}`);
    lines.push(
      `  ${fg(COLORS.muted, t("context.system_tokens") + ":")}       ` +
      fg("yellow", fmtTokens(systemTokens)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("context.conversation_tokens") + ":")} ` +
      fg(COLORS.compConversation ?? "cyan", fmtTokens(convTokens)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("context.buffer_tokens") + ":")}       ` +
      fg(COLORS.compAutoContext, fmtTokens(bufferTokens)),
    );
    lines.push(
      `  ${fg(COLORS.muted, t("context.free_tokens") + ":")}         ` +
      fg("green", fmtTokens(freeTokens)),
    );
    lines.push("");

    // ── Cost ──────────────────────────────────────────────────────────────
    lines.push(`  ${fgBold(COLORS.header, "── " + t("session.cost") + " ──")}`);
    lines.push(
      `  ${fg(m.cost === 0 ? "green" : "white", fmtCost(m.cost))}`,
    );
    lines.push("");

    // ── Steps & Actions ────────────────────────────────────────────────────
    lines.push(`  ${fgBold(COLORS.header, "── " + t("steps.title") + " & Actions ──")}`);
    lines.push(
      `  ${fg(COLORS.muted, t("session.steps") + ":")}  ` +
      fg("cyan", `${m.step_count}`) +
      `  ${fg(COLORS.keyHint, "[S]")}` +
      `   ${fg(COLORS.muted, t("session.tool_calls") + ":")} ` +
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

    lines.push(
      `  ${fg(COLORS.keyHint, "[D]")} ${fg(COLORS.muted, t("keys.details"))}`,
    );

    // Injected diffs warning
    if (m.injected_diffs_count > 0) {
      lines.push("");
      lines.push(
        `  ${fg(COLORS.warning, "⚠")} ` +
        `${fg(COLORS.warning, `${m.injected_diffs_count} ${t("composition.diffs_injected")}`)}`
      );
    }

    this.contextBox.setContent(lines.join("\n"));
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
    lines.push(`  ${fgBold(COLORS.header, t("steps.title"))}  ${fg(COLORS.muted, `(${totalSteps} ${t("billing.steps_label")})`)}`);;
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

      // Model and agent for this step
      if (step.model_id || step.agent) {
        lines.push(
          `  ${fg(COLORS.muted, t("steps.model_agent") + ":")}` +
          ` ${fg("white", shortModelId(step.model_id))}` +
          `  ${fg(COLORS.muted, "·")}  ${fg("cyan", step.agent)}`,
        );
      }

      // User prompt that triggered this step
      if (step.user_prompt) {
        lines.push(
          `  ${fg(COLORS.muted, t("steps.user_prompt") + ":")} ` +
          fg(COLORS.muted, truncate(step.user_prompt, 100)),
        );
      }

      // Context window bar for this step
      const ctxColor = gaugeColor(step.context_percentage);
      const ctxBar = asciiBar(step.context_percentage, 20, ctxColor, "#000000");
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
        const effBar = asciiBar(step.cache_efficiency, 16, effColor, "#000000");
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
        `${fg(COLORS.muted, `(${sub.steps.length} ${t("billing.steps_label")})`)}`,
    );
    lines.push("");

    for (const step of sub.steps) {
      const isCold = step.step_number === 1;
      const ctxColor = gaugeColor(step.context_percentage);
      const ctxBar = asciiBar(step.context_percentage, 18, ctxColor, "#000000");

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
      style: { fg: "#000000", bg: "green", border: { fg: "green" }, focus: { bg: "white" }, hover: { bg: "white" } },
    });

    const cancelBtn = blessed.button({
      parent: this.settingsOverlay,
      top: 11, left: 18, width: 14, height: 3,
      content: `  ${t("settings.cancel")}  `,
      tags: true, border: { type: "line" }, mouse: true, keys: true,
      style: { fg: "white", bg: "#000000", border: { fg: "gray" }, focus: { bg: "gray" }, hover: { bg: "gray" } },
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
      sep + hint("/", t("search.shortcut")) +
      sep + hint("N", t("keys.rename")) +
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
    this.sessionBox.options.label = ` ${t("panel.sessions")} `;
    this.contextBox.options.label = ` ${t("panel.context")} `;
    this.timelineBox.options.label = ` ${t("panel.timeline")} `;
    this.stepsOverlay.options.label = ` ${t("panel.steps")} `;
    this.toolsOverlay.options.label = ` ${t("panel.tools")} `;
    this.subagentOverlay.options.label = ` ${t("panel.subagent")} `;
  }

  // Silence the unused variable warnings for `bold`
  private _unusedBold = bold;
}
