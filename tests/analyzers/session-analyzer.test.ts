import { describe, it, expect, beforeEach } from "bun:test";
import { SessionAnalyzer } from "../../src/analyzers/session-analyzer.ts";
import type { IDbSession, IMessage, IPart } from "../../src/models/session.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<IDbSession> = {}): IDbSession {
  return {
    id: "ses_test",
    project_id: "proj_test",
    parent_id: null,
    slug: "test",
    directory: "/tmp/test",
    title: "Test session",
    version: "1",
    share_url: null,
    summary_additions: 0,
    summary_deletions: 0,
    summary_files: 0,
    summary_diffs: null,
    time_created: 1000,
    time_updated: 9000,
    time_archived: null,
    workspace_id: null,
    ...overrides,
  };
}

function makeAssistantMessage(
  id: string,
  tokens: { total?: number; input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number },
  overrides: Partial<IMessage> = {},
): IMessage {
  return {
    id,
    session_id: "ses_test",
    time_created: 1000,
    time_updated: 2000,
    data: {
      role: "assistant",
      agent: "build",
      modelID: "claude-opus-4-5",
      providerID: "anthropic",
      cost: 0.01,
      tokens: {
        total: tokens.total,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning ?? 0,
        cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
      },
      time: { created: 1000, completed: 2000 },
      finish: "stop",
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionAnalyzer", () => {
  let analyzer: SessionAnalyzer;
  let session: IDbSession;
  const noParts: IPart[] = [];

  beforeEach(() => {
    analyzer = new SessionAnalyzer();
    session = makeSession();
  });

  // ─── Billing Totals ─────────────────────────────────────────────────────────

  describe("billing totals (fresh input vs cache reused)", () => {
    it("computes total_fresh_input as the sum of each step's input tokens", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
        makeAssistantMessage("m3", { total: 20000, input: 1500, cacheRead: 16500, output: 600 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.total_fresh_input).toBe(10000 + 2000 + 1500);
    });

    it("computes total_cache_reused as the sum of each step's cache.read tokens", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
        makeAssistantMessage("m3", { total: 20000, input: 1500, cacheRead: 16500, output: 600 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.total_cache_reused).toBe(0 + 8000 + 16500);
    });

    it("computes overall_cache_efficiency as cache_reused / (cache_reused + fresh_input)", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      // fresh = 12000, cached = 8000 → efficiency = 8000/20000 = 40%
      expect(metrics.overall_cache_efficiency).toBeCloseTo(40, 1);
    });

    it("returns 0 cache efficiency when there are no tokens", () => {
      const metrics = analyzer.analyze(session, [], noParts);
      expect(metrics.overall_cache_efficiency).toBe(0);
    });

    it("returns 0 cache efficiency when no cache was read", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.overall_cache_efficiency).toBe(0);
    });

    it("returns 100% cache efficiency when all input comes from cache", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 0, cacheRead: 10000, output: 500 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.overall_cache_efficiency).toBeCloseTo(100, 1);
    });
  });

  // ─── Context Window ─────────────────────────────────────────────────────────

  describe("context window tracking", () => {
    it("last_step_tokens reflects the last assistant message's token window", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
        makeAssistantMessage("m3", { total: 20000, input: 1500, cacheRead: 16500, output: 600 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.last_step_tokens.total).toBe(20000);
    });

    it("peak_context_tokens is the maximum total across all steps", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 35000, input: 2000, cacheRead: 33000, output: 1000 }),
        makeAssistantMessage("m3", { total: 20000, input: 1500, cacheRead: 18500, output: 600 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.peak_context_tokens).toBe(35000);
    });

    it("last_step_tokens != peak_context_tokens when context window shrinks", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 50000, input: 2000, cacheRead: 48000, output: 5000 }),
        // Context reset or compaction caused a smaller last step
        makeAssistantMessage("m3", { total: 15000, input: 15000, output: 500 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.peak_context_tokens).toBe(50000);
      expect(metrics.last_step_tokens.total).toBe(15000);
    });
  });

  // ─── Step Metrics ───────────────────────────────────────────────────────────

  describe("per-step metrics (buildStepMetrics)", () => {
    it("builds one step per valid assistant message", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.steps.length).toBe(2);
    });

    it("assigns sequential step numbers starting at 1", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
        makeAssistantMessage("m3", { total: 22000, input: 1500, cacheRead: 20500, output: 700 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      expect(metrics.steps[0]!.step_number).toBe(1);
      expect(metrics.steps[1]!.step_number).toBe(2);
      expect(metrics.steps[2]!.step_number).toBe(3);
    });

    it("skips aborted steps (total=0, input=0, output=0)", () => {
      const abortedMsg: IMessage = {
        id: "m-aborted",
        session_id: "ses_test",
        time_created: 1500,
        time_updated: 1600,
        data: {
          role: "assistant",
          agent: "build",
          tokens: { total: undefined, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "error",
        },
      };
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        abortedMsg,
        makeAssistantMessage("m3", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      // Only 2 valid steps
      expect(metrics.steps.length).toBe(2);
      expect(metrics.steps[0]!.step_number).toBe(1);
      expect(metrics.steps[1]!.step_number).toBe(2);
    });

    it("computes context_growth correctly as delta from previous step", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      // First step: growth = 10000 - 0 = 10000
      expect(metrics.steps[0]!.context_growth).toBe(10000);
      // Second step: growth = 18000 - 10000 = 8000
      expect(metrics.steps[1]!.context_growth).toBe(8000);
    });

    it("computes cache_efficiency per step", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
        makeAssistantMessage("m2", { total: 18000, input: 2000, cacheRead: 8000, output: 800 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      // Step 1: no cache, efficiency = 0%
      expect(metrics.steps[0]!.cache_efficiency).toBeCloseTo(0, 1);
      // Step 2: 8000 / (8000 + 2000) = 80%
      expect(metrics.steps[1]!.cache_efficiency).toBeCloseTo(80, 1);
    });

    it("returns empty steps array for sessions with no assistant messages", () => {
      const metrics = analyzer.analyze(session, [], noParts);
      expect(metrics.steps).toEqual([]);
    });
  });

  // ─── Summary ────────────────────────────────────────────────────────────────

  describe("toSummary", () => {
    it("has_data is false when total_tokens is 0", () => {
      const metrics = analyzer.analyze(session, [], noParts);
      const summary = analyzer.toSummary(metrics);
      expect(summary.has_data).toBe(false);
    });

    it("has_data is true when there are token totals", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      const summary = analyzer.toSummary(metrics);
      expect(summary.has_data).toBe(true);
    });

    it("returns the correct session id and model id", () => {
      const messages: IMessage[] = [
        makeAssistantMessage("m1", { total: 10000, input: 10000, output: 500 }),
      ];
      const metrics = analyzer.analyze(session, messages, noParts);
      const summary = analyzer.toSummary(metrics);
      expect(summary.id).toBe("ses_test");
      expect(summary.model_id).toBe("claude-opus-4-5");
    });
  });
});
