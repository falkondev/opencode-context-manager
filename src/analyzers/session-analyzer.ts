import type { IDbSession, IMessage, IPart, IPartDataStepFinish, IPartDataTask, IPartDataTool } from "../models/session.ts";
import {
  CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  type ISessionMetrics,
  type ISessionSummary,
  type ISubagentMetrics,
  type ISubagentDetail,
  type IStepMetrics,
  type IToolDetail,
  type IToolAggregation,
  type ITimelineEvent,
  type ITokenMetrics,
  type ITokenComposition,
  type TimelineEventType,
} from "../models/metrics.ts";
import { logger } from "../utils/logger.ts";

// Built-in tool names shipped with OpenCode
const BUILTIN_TOOLS = new Set([
  "bash", "read", "write", "edit", "glob", "grep",
  "task", "todowrite", "question", "webfetch", "skill",
  "patch", "list_directory",
]);

/**
 * Determines the human-readable owner of a tool call.
 * Built-in tools are "Built-in"; MCP tools derive their server name from
 * the naming convention "<ServerPrefix>_<ToolName>".
 */
function resolveToolOwner(toolName: string): string {
  if (BUILTIN_TOOLS.has(toolName.toLowerCase())) return "Built-in";

  // MCP tools follow snake_case conventions. Try to identify server prefix.
  // e.g. "SQLIte_MCP_Server_Opencode_Folder_query" → "MCP: SQLite"
  // e.g. "opencode_Docs_search_opencode_documentation" → "MCP: OpenCode Docs"
  const lower = toolName.toLowerCase();
  if (lower.startsWith("sqlite") || lower.includes("_mcp_server_")) return "MCP: SQLite";
  if (lower.startsWith("opencode_docs") || lower.includes("_docs_")) return "MCP: OpenCode Docs";
  if (lower.startsWith("github")) return "MCP: GitHub";

  // Generic MCP fallback: try to extract a server name from the prefix
  const underscoreIdx = toolName.indexOf("_");
  if (underscoreIdx > 0) {
    return `MCP: ${toolName.slice(0, underscoreIdx)}`;
  }
  return "MCP";
}

/**
 * Computes full ISessionMetrics from raw DB rows.
 */
export class SessionAnalyzer {
  public analyze(
    session: IDbSession,
    messages: IMessage[],
    parts: IPart[],
    childSessions: Array<{ session: IDbSession; messages: IMessage[]; parts: IPart[] }> = [],
  ): ISessionMetrics {
    const assistantMessages = messages.filter((m) => m.data.role === "assistant");
    const userMessages = messages.filter((m) => m.data.role === "user");

    // Identity: prefer last assistant message's model info
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const modelId =
      lastAssistant?.data.modelID ??
      userMessages[0]?.data.model?.modelID ??
      "unknown";
    const providerId =
      lastAssistant?.data.providerID ??
      userMessages[0]?.data.model?.providerID ??
      "unknown";
    const agent = lastAssistant?.data.agent ?? userMessages[0]?.data.agent ?? "build";

    if (modelId === "unknown") {
      logger.warn("session-analyzer", `Model ID unknown for session ${session.id}`, {
        title: session.title,
        assistant_messages: assistantMessages.length,
        user_messages: userMessages.length,
      });
    }

    // Determine context limit for this session
    const contextLimit = this.getContextLimit(modelId);

    // Token aggregation across all assistant messages (billing totals)
    const tokens = this.aggregateTokens(assistantMessages);

    // Context window — peak turn
    const peakTurnTokens = this.getPeakTurnTokens(assistantMessages);
    const peakContextTokens = peakTurnTokens.total;
    // Use peak turn's model if available (multi-model sessions)
    const peakContextLimit = this.getContextLimit(
      peakTurnTokens.modelId !== "unknown" ? peakTurnTokens.modelId : modelId,
    );
    const contextPercentage =
      peakContextTokens > 0 ? Math.round((peakContextTokens / peakContextLimit) * 100) : 0;

    // Last step tokens (current context window state)
    const lastStepTokens = this.getLastStepTokens(assistantMessages);
    const lastStepContextLimit = this.getContextLimit(
      lastStepTokens.modelId !== "unknown" ? lastStepTokens.modelId : modelId,
    );
    const lastStepContextPercentage =
      lastStepTokens.total > 0
        ? Math.round((lastStepTokens.total / lastStepContextLimit) * 100)
        : 0;

    // Billing aggregates (real cost breakdown across all steps)
    const totalFreshInput = assistantMessages.reduce(
      (acc, m) => acc + (m.data.tokens?.input ?? 0), 0,
    );
    const totalCacheReused = assistantMessages.reduce(
      (acc, m) => acc + (m.data.tokens?.cache?.read ?? 0), 0,
    );
    const overallCacheEfficiency =
      totalFreshInput + totalCacheReused > 0
        ? (totalCacheReused / (totalFreshInput + totalCacheReused)) * 100
        : 0;

    // Cost & finish reason from last completed assistant message
    const lastCompleted = [...assistantMessages]
      .reverse()
      .find((m) => m.data.time?.completed !== undefined);
    const cost = this.sumCost(assistantMessages);
    const finishReason =
      lastCompleted?.data.finish ?? parts
        .filter((p) => p.data.type === "step-finish")
        .map((p) => (p.data as IPartDataStepFinish).reason)
        .filter(Boolean)
        .pop() ?? "unknown";

    // Timing
    const sessionCreated = session.time_created;
    const lastCompletedTime = lastCompleted?.data.time?.completed ?? session.time_updated;
    const durationTotalMs = lastCompletedTime - sessionCreated;

    const stepStartParts = parts.filter((p) => p.data.type === "step-start");
    const stepFinishParts = parts.filter((p) => p.data.type === "step-finish");
    const firstStepStart = stepStartParts[0];
    const lastStepFinish = stepFinishParts[stepFinishParts.length - 1];
    const durationModelMs =
      firstStepStart && lastStepFinish
        ? lastStepFinish.time_created - firstStepStart.time_created
        : 0;

    // Auto-context metadata
    const injectedDiffsCount = this.countInjectedDiffs(userMessages);
    const userMsgByteSize = this.getUserMsgByteSize(userMessages);

    // Tool calls and step counts
    const toolCallParts = parts.filter((p) => p.data.type === "tool");
    const toolCallsCount = toolCallParts.length;
    const stepCount = stepFinishParts.length;

    // Token composition estimation
    const firstAssistant = assistantMessages[0];
    const tokenComposition = this.estimateComposition(
      firstAssistant,
      parts,
      userMessages,
      injectedDiffsCount,
      userMsgByteSize,
    );

    // Timeline
    const timeline = this.buildTimeline(session, messages, parts);

    // ── New: per-step details ─────────────────────────────────────────────────
    const steps = this.buildStepMetrics(assistantMessages, parts, peakContextLimit);

    // ── New: tool details + aggregation ──────────────────────────────────────
    const toolsDetail = this.buildToolDetails(parts);
    const toolsAggregation = this.aggregateTools(toolsDetail);

    // ── New/Updated: subagent details ─────────────────────────────────────────
    const taskParts = parts.filter(
      (p): p is IPart & { data: IPartDataTask } =>
        p.data.type === "tool" && (p.data as IPartDataTask).tool === "task",
    );
    const subagents = this.buildSubagentMetrics(taskParts, childSessions);
    const subagentDetails = this.buildSubagentDetails(taskParts, childSessions);

    // Live detection
    const isLive =
      assistantMessages.some(
        (m) => m.data.time?.completed === undefined && m.data.time?.created !== undefined,
      ) || (session.time_updated > Date.now() - 30_000 && !lastCompleted);

    logger.debug("session-analyzer", `analyze() complete for ${session.id}`, {
      title: session.title,
      steps: steps.length,
      total_fresh_input: totalFreshInput,
      total_cache_reused: totalCacheReused,
      overall_cache_efficiency: overallCacheEfficiency.toFixed(1) + "%",
      peak_context_tokens: peakContextTokens,
      last_step_total: lastStepTokens.total,
      tool_calls: toolCallsCount,
      subagents: subagents.length,
    });

    return {
      session,
      model_id: modelId,
      provider_id: providerId,
      agent,
      tokens,
      peak_turn_tokens: peakTurnTokens,
      last_step_tokens: lastStepTokens,
      token_composition: tokenComposition,
      context_limit: peakContextLimit,
      context_percentage: contextPercentage,
      peak_context_tokens: peakContextTokens,
      last_step_context_percentage: lastStepContextPercentage,
      total_fresh_input: totalFreshInput,
      total_cache_reused: totalCacheReused,
      overall_cache_efficiency: overallCacheEfficiency,
      cost,
      finish_reason: finishReason,
      duration_total_ms: Math.max(0, durationTotalMs),
      duration_model_ms: Math.max(0, durationModelMs),
      injected_diffs_count: injectedDiffsCount,
      user_message_byte_size: userMsgByteSize,
      tool_calls_count: toolCallsCount,
      step_count: stepCount,
      steps,
      tools_detail: toolsDetail,
      tools_aggregation: toolsAggregation,
      subagents,
      subagent_details: subagentDetails,
      timeline,
      is_live: isLive,
    };
  }

  public toSummary(metrics: ISessionMetrics): ISessionSummary {
    return {
      id: metrics.session.id,
      title: metrics.session.title,
      directory: metrics.session.directory,
      model_id: metrics.model_id,
      provider_id: metrics.provider_id,
      total_tokens: metrics.tokens.total,
      context_percentage: metrics.context_percentage,
      duration_ms: metrics.duration_total_ms,
      time_created: metrics.session.time_created,
      is_live: metrics.is_live,
      has_data: metrics.tokens.total > 0,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private aggregateTokens(assistantMsgs: IMessage[]): ITokenMetrics {
    let total = 0;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    for (const msg of assistantMsgs) {
      const t = msg.data.tokens;
      if (!t) continue;
      total += t.total ?? t.input + t.output;
      input += t.input;
      output += t.output;
      reasoning += t.reasoning;
      cacheRead += t.cache.read;
      cacheWrite += t.cache.write;
    }

    return { total, input, output, reasoning, cache_read: cacheRead, cache_write: cacheWrite };
  }

  /**
   * Returns the ITokenMetrics for the single turn with the highest total.
   */
  private getPeakTurnTokens(assistantMsgs: IMessage[]): ITokenMetrics & { modelId: string } {
    let peakTotal = 0;
    let peakMsg: IMessage | undefined;
    for (const msg of assistantMsgs) {
      const t = msg.data.tokens;
      if (!t) continue;
      const turn = t.total ?? t.input + t.output;
      if (turn > peakTotal) {
        peakTotal = turn;
        peakMsg = msg;
      }
    }
    if (!peakMsg?.data.tokens) {
      return { total: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, modelId: "unknown" };
    }
    const t = peakMsg.data.tokens;
    return {
      total: t.total ?? t.input + t.output,
      input: t.input,
      output: t.output,
      reasoning: t.reasoning,
      cache_read: t.cache.read,
      cache_write: t.cache.write,
      modelId: peakMsg.data.modelID ?? "unknown",
    };
  }

  /**
   * Returns ITokenMetrics for the LAST completed assistant message.
   * This represents the current state of the context window.
   */
  private getLastStepTokens(assistantMsgs: IMessage[]): ITokenMetrics & { modelId: string } {
    // Find the last message that has token data
    const withTokens = assistantMsgs.filter((m) => m.data.tokens);
    const lastMsg = withTokens[withTokens.length - 1];
    if (!lastMsg?.data.tokens) {
      return { total: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, modelId: "unknown" };
    }
    const t = lastMsg.data.tokens;
    return {
      total: t.total ?? t.input + t.output,
      input: t.input,
      output: t.output,
      reasoning: t.reasoning,
      cache_read: t.cache.read,
      cache_write: t.cache.write,
      modelId: lastMsg.data.modelID ?? "unknown",
    };
  }

  /**
   * Builds per-step metrics from assistant messages.
   * Each assistant message corresponds to one LLM inference step.
   */
  private buildStepMetrics(
    assistantMsgs: IMessage[],
    parts: IPart[],
    contextLimit: number,
  ): IStepMetrics[] {
    const steps: IStepMetrics[] = [];

    // Build a map of message_id → tool parts for quick lookup
    const partsByMessage = new Map<string, IPart[]>();
    for (const part of parts) {
      if (!partsByMessage.has(part.message_id)) {
        partsByMessage.set(part.message_id, []);
      }
      partsByMessage.get(part.message_id)!.push(part);
    }

    let prevTotal = 0;
    let stepNum = 0;

    for (let i = 0; i < assistantMsgs.length; i++) {
      const msg = assistantMsgs[i]!;
      const t = msg.data.tokens;
      if (!t) continue; // skip messages without token data

      const total = t.total ?? t.input + t.output;
      // Skip aborted/empty steps (no context window snapshot — total would be 0)
      if (total === 0 && t.input === 0 && t.output === 0) continue;

      stepNum++;
      const input = t.input;
      const output = t.output;
      const reasoning = t.reasoning;
      const cacheRead = t.cache.read;
      const cacheWrite = t.cache.write;
      const cost = msg.data.cost ?? 0;

      // Duration from message timestamps
      const created = msg.data.time?.created ?? msg.time_created;
      const completed = msg.data.time?.completed;
      const durationMs = completed !== undefined ? Math.max(0, completed - created) : 0;

      // Context window info
      const msgModelId = msg.data.modelID ?? "unknown";
      const effectiveLimit = msgModelId !== "unknown"
        ? this.getContextLimit(msgModelId)
        : contextLimit;
      const contextPct = total > 0 ? Math.round((total / effectiveLimit) * 100) : 0;

      // Deltas vs previous step
      const contextGrowth = total - prevTotal;
      const cacheEfficiency =
        cacheRead + input > 0 ? (cacheRead / (cacheRead + input)) * 100 : 0;

      // Finish reason from step-finish part of this message
      const msgParts = partsByMessage.get(msg.id) ?? [];
      const stepFinishPart = msgParts.find((p) => p.data.type === "step-finish");
      const finishReason = stepFinishPart
        ? (stepFinishPart.data as IPartDataStepFinish).reason
        : (msg.data.finish ?? "unknown");

      // Tool details for this step
      const toolDetails = this.buildToolDetails(msgParts);

      const step: IStepMetrics = {
        step_number: stepNum,
        message_id: msg.id,
        timestamp: created,
        duration_ms: durationMs,
        tokens: { total, input, output, reasoning, cache_read: cacheRead, cache_write: cacheWrite },
        context_limit: effectiveLimit,
        context_percentage: contextPct,
        context_growth: contextGrowth,
        cache_efficiency: cacheEfficiency,
        tool_calls: toolDetails,
        cost,
        finish_reason: finishReason,
      };

      steps.push(step);
      prevTotal = total;
    }

    logger.debug("session-analyzer", `buildStepMetrics: ${steps.length} steps`, {
      steps: steps.map((s) => ({
        n: s.step_number,
        total: s.tokens.total,
        input: s.tokens.input,
        cache_read: s.tokens.cache_read,
        cache_efficiency: s.cache_efficiency.toFixed(1) + "%",
        context_pct: s.context_percentage + "%",
        growth: s.context_growth,
      })),
    });

    return steps;
  }

  /**
   * Builds IToolDetail[] from a list of parts (can be all session parts or message parts).
   */
  private buildToolDetails(parts: IPart[]): IToolDetail[] {
    const details: IToolDetail[] = [];

    for (const part of parts) {
      if (part.data.type !== "tool") continue;
      const toolPart = part.data as IPartDataTool;
      const state = toolPart.state;

      const startMs = state.time?.start ?? 0;
      const endMs = state.time?.end ?? 0;
      const durationMs = startMs > 0 && endMs > 0 ? Math.max(0, endMs - startMs) : 0;

      const inputSummary = state.input
        ? JSON.stringify(state.input).slice(0, 100)
        : "";
      const outputSummary = state.output
        ? String(state.output).slice(0, 100)
        : "";

      // Use title from state if available, else fall back to tool name
      const title = (state as { title?: string }).title ?? toolPart.tool;

      details.push({
        call_id: toolPart.callID,
        tool_name: toolPart.tool,
        tool_owner: resolveToolOwner(toolPart.tool),
        status: state.status,
        title,
        duration_ms: durationMs,
        has_error: state.status === "error" || !!state.error,
        input_summary: inputSummary,
        output_summary: outputSummary,
      });
    }

    return details;
  }

  /**
   * Aggregates tool details by tool_name for summary display.
   */
  private aggregateTools(toolDetails: IToolDetail[]): IToolAggregation[] {
    const map = new Map<string, IToolAggregation>();

    for (const detail of toolDetails) {
      const key = detail.tool_name;
      if (!map.has(key)) {
        map.set(key, {
          tool_name: detail.tool_name,
          tool_owner: detail.tool_owner,
          total_calls: 0,
          completed_calls: 0,
          error_count: 0,
          total_duration_ms: 0,
          avg_duration_ms: 0,
        });
      }
      const agg = map.get(key)!;
      agg.total_calls++;
      if (detail.status === "completed") agg.completed_calls++;
      if (detail.has_error) agg.error_count++;
      agg.total_duration_ms += detail.duration_ms;
    }

    // Compute averages and sort by total_calls desc
    const result = Array.from(map.values()).map((agg) => ({
      ...agg,
      avg_duration_ms: agg.total_calls > 0 ? agg.total_duration_ms / agg.total_calls : 0,
    }));

    result.sort((a, b) => b.total_calls - a.total_calls);
    return result;
  }

  private sumCost(assistantMsgs: IMessage[]): number {
    return assistantMsgs.reduce((acc, m) => acc + (m.data.cost ?? 0), 0);
  }

  private getContextLimit(modelId: string): number {
    const exact = CONTEXT_LIMITS[modelId];
    if (exact !== undefined) return exact;

    const lower = modelId.toLowerCase();
    for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
      if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
        return limit;
      }
    }

    logger.debug("session-analyzer", `No context limit for model "${modelId}" — using default ${DEFAULT_CONTEXT_LIMIT}`);
    return DEFAULT_CONTEXT_LIMIT;
  }

  private countInjectedDiffs(userMessages: IMessage[]): number {
    let count = 0;
    for (const msg of userMessages) {
      count += msg.data.summary?.diffs?.length ?? 0;
    }
    return count;
  }

  private getUserMsgByteSize(userMessages: IMessage[]): number {
    let total = 0;
    for (const msg of userMessages) {
      total += JSON.stringify(msg.data).length;
    }
    return total;
  }

  private estimateComposition(
    firstAssistantMsg: IMessage | undefined,
    parts: IPart[],
    userMessages: IMessage[],
    injectedDiffs: number,
    userMsgByteSize: number,
  ): ITokenComposition {
    const coldInputTokens = firstAssistantMsg?.data.tokens?.input ?? 0;
    const coldTotal = firstAssistantMsg?.data.tokens
      ? (firstAssistantMsg.data.tokens.total ?? coldInputTokens)
      : 0;

    const userMessageIds = new Set(userMessages.map((m) => m.id));
    const userTextChars = parts
      .filter((p) => p.data.type === "text" && userMessageIds.has(p.message_id))
      .map((p) => (p.data.type === "text" ? p.data.text?.length ?? 0 : 0))
      .reduce((a, b) => a + b, 0);

    const userTextTokens = Math.min(Math.round(userTextChars / 4), coldInputTokens);

    const autoContextChars = Math.max(0, userMsgByteSize - userTextChars);
    const autoContextTokens =
      injectedDiffs > 0
        ? Math.min(Math.round(autoContextChars / 4), coldInputTokens - userTextTokens)
        : 0;

    const systemPromptTokens = Math.max(
      0,
      coldInputTokens - userTextTokens - autoContextTokens,
    );

    return {
      system_prompt_tokens: systemPromptTokens,
      auto_context_tokens: autoContextTokens,
      user_text_tokens: userTextTokens,
      total_input: coldTotal,
    };
  }

  private buildTimeline(
    session: IDbSession,
    messages: IMessage[],
    parts: IPart[],
  ): ITimelineEvent[] {
    const events: ITimelineEvent[] = [];
    const base = session.time_created;

    const push = (
      id: string,
      timestamp: number,
      type: TimelineEventType,
      label: string,
      detail?: string,
    ) => {
      events.push({ id, timestamp, elapsed_ms: timestamp - base, type, label, detail });
    };

    push("session-created", session.time_created, "session-created", session.title);

    for (const msg of messages) {
      if (msg.data.role === "user") {
        const diffsCount = msg.data.summary?.diffs?.length ?? 0;
        push(
          msg.id,
          msg.time_created,
          "message-sent",
          "timeline.message_sent",
          diffsCount > 0 ? `${diffsCount} diffs` : undefined,
        );
      }
    }

    for (const part of parts) {
      if (part.data.type === "step-start") {
        push(part.id, part.time_created, "step-start", "timeline.step_start", part.data.snapshot?.slice(0, 8));
      } else if (part.data.type === "step-finish") {
        const sf = part.data as IPartDataStepFinish;
        const total = sf.tokens?.total ?? 0;
        push(
          part.id,
          part.time_created,
          "step-finish",
          "timeline.step_finish",
          total > 0 ? `${total.toLocaleString()} tokens` : undefined,
        );
      } else if (part.data.type === "tool") {
        if (part.data.state.status === "completed") {
          push(part.id, part.time_created, "tool-call", "timeline.tool_call", part.data.tool);
        }
      }
    }

    for (const msg of messages) {
      if (msg.data.role === "assistant" && msg.data.time?.completed) {
        push(
          `${msg.id}-completed`,
          msg.data.time.completed,
          "model-response",
          "timeline.model_response",
          msg.data.modelID ?? undefined,
        );
      }
    }

    events.sort((a, b) => a.timestamp - b.timestamp);
    return events;
  }

  /**
   * Builds ISubagentMetrics[] for basic token panel display.
   */
  private buildSubagentMetrics(
    taskParts: Array<IPart & { data: IPartDataTask }>,
    childSessions: Array<{ session: IDbSession; messages: IMessage[]; parts: IPart[] }>,
  ): ISubagentMetrics[] {
    const results: ISubagentMetrics[] = [];

    for (const part of taskParts) {
      const state = part.data.state;
      if (state.status !== "completed") continue;

      const childSessionId = state.metadata?.sessionId;
      const agentType = state.input.subagent_type ?? "unknown";
      const description = state.input.description ?? "";
      const modelId = state.metadata?.model?.modelID ?? "unknown";

      const durationMs =
        state.time?.start !== undefined && state.time?.end !== undefined
          ? Math.max(0, state.time.end - state.time.start)
          : 0;

      const childEntry = childSessions.find((c) => c.session.id === childSessionId);
      const childMessages = childEntry?.messages ?? [];
      const childAssistant = childMessages.filter((m) => m.data.role === "assistant");

      const peakTurn = this.getPeakTurnTokens(childAssistant);
      const peakTokens = peakTurn.total;

      const effectiveModel = peakTurn.modelId !== "unknown" ? peakTurn.modelId : modelId;
      const childContextLimit = this.getContextLimit(effectiveModel);
      const contextPercentage =
        peakTokens > 0 ? Math.round((peakTokens / childContextLimit) * 100) : 0;

      const cost = this.sumCost(childAssistant);

      results.push({
        session_id: childSessionId ?? "",
        agent_type: agentType,
        description,
        model_id: effectiveModel,
        peak_tokens: peakTokens,
        context_limit: childContextLimit,
        context_percentage: contextPercentage,
        cost,
        duration_ms: durationMs,
      });
    }

    return results;
  }

  /**
   * Builds ISubagentDetail[] with full step/tool breakdown for the Subagents overlay.
   */
  private buildSubagentDetails(
    taskParts: Array<IPart & { data: IPartDataTask }>,
    childSessions: Array<{ session: IDbSession; messages: IMessage[]; parts: IPart[] }>,
  ): ISubagentDetail[] {
    const results: ISubagentDetail[] = [];

    for (const part of taskParts) {
      const state = part.data.state;
      if (state.status !== "completed") continue;

      const childSessionId = state.metadata?.sessionId;
      const agentType = state.input.subagent_type ?? "unknown";
      const description = state.input.description ?? "";
      const modelId = state.metadata?.model?.modelID ?? "unknown";

      const durationMs =
        state.time?.start !== undefined && state.time?.end !== undefined
          ? Math.max(0, state.time.end - state.time.start)
          : 0;

      const childEntry = childSessions.find((c) => c.session.id === childSessionId);
      const childMessages = childEntry?.messages ?? [];
      const childParts = childEntry?.parts ?? [];
      const childAssistant = childMessages.filter((m) => m.data.role === "assistant");

      const peakTurn = this.getPeakTurnTokens(childAssistant);
      const peakTokens = peakTurn.total;
      const effectiveModel = peakTurn.modelId !== "unknown" ? peakTurn.modelId : modelId;
      const childContextLimit = this.getContextLimit(effectiveModel);
      const contextPercentage =
        peakTokens > 0 ? Math.round((peakTokens / childContextLimit) * 100) : 0;

      const cost = this.sumCost(childAssistant);

      // Billing totals for the subagent
      const tokensBilling = this.aggregateTokens(childAssistant);

      // Per-step data for the subagent
      const steps = this.buildStepMetrics(childAssistant, childParts, childContextLimit);

      // Tool data for the subagent
      const toolsDetail = this.buildToolDetails(childParts);
      const toolsAggregation = this.aggregateTools(toolsDetail);

      // Cache efficiency for the subagent
      const totalFresh = childAssistant.reduce((acc, m) => acc + (m.data.tokens?.input ?? 0), 0);
      const totalCache = childAssistant.reduce((acc, m) => acc + (m.data.tokens?.cache?.read ?? 0), 0);
      const cacheEfficiency =
        totalFresh + totalCache > 0 ? (totalCache / (totalFresh + totalCache)) * 100 : 0;

      // Shared context: the first step's input represents the inherited context
      // (system prompt + task description passed from parent)
      const sharedContextTokens = steps[0]?.tokens.input ?? 0;

      logger.debug("session-analyzer", `Subagent detail for ${childSessionId}`, {
        agent_type: agentType,
        steps: steps.length,
        tools: toolsDetail.length,
        peak_tokens: peakTokens,
        cache_efficiency: cacheEfficiency.toFixed(1) + "%",
        shared_context_tokens: sharedContextTokens,
      });

      results.push({
        session_id: childSessionId ?? "",
        agent_type: agentType,
        description,
        model_id: effectiveModel,
        peak_tokens: peakTokens,
        context_limit: childContextLimit,
        context_percentage: contextPercentage,
        cost,
        duration_ms: durationMs,
        steps,
        tools_aggregation: toolsAggregation,
        tokens_billing: tokensBilling,
        cache_efficiency: cacheEfficiency,
        shared_context_tokens: sharedContextTokens,
      });
    }

    return results;
  }
}
