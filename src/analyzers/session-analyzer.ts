import type { IDbSession, IMessage, IPart, ITokens, IPartDataStepFinish, IPartDataTask } from "../models/session.ts";
import {
  CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  type ISessionMetrics,
  type ISessionSummary,
  type ISubagentMetrics,
  type ITimelineEvent,
  type ITokenMetrics,
  type ITokenComposition,
  type TimelineEventType,
} from "../models/metrics.ts";
import { logger } from "../utils/logger.ts";

/**
 * Computes full ISessionMetrics from raw DB rows.
 */
export class SessionAnalyzer {
  public analyze(
    session: IDbSession,
    messages: IMessage[],
    parts: IPart[],
    childSessions: Array<{ session: IDbSession; messages: IMessage[] }> = [],
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

    // Token aggregation across all assistant messages
    const tokens = this.aggregateTokens(assistantMessages);

    // Context window
    // In multi-turn sessions each message's `total` already includes cache tokens
    // from the previous context, so summing all totals double-counts context.
    // The correct context usage metric is the peak (max) total seen in any single
    // turn, which represents how much of the context window was actually occupied.
    const peakTurnTokens = this.getPeakTurnTokens(assistantMessages);
    const peakContextTokens = peakTurnTokens.total;
    // Use the model of the peak turn to determine the correct context limit —
    // sessions may span multiple models (e.g. haiku → sonnet switch mid-session).
    const contextLimit = this.getContextLimit(peakTurnTokens.modelId !== "unknown" ? peakTurnTokens.modelId : modelId);
    const contextPercentage =
      peakContextTokens > 0 ? Math.round((peakContextTokens / contextLimit) * 100) : 0;

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
    const firstCompleted = assistantMessages.find(
      (m) => m.data.time?.completed !== undefined,
    );
    const lastCompletedTime = lastCompleted?.data.time?.completed ?? session.time_updated;
    const durationTotalMs = lastCompletedTime - sessionCreated;

    // Model processing time: step-start to step-finish
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
    // Pass the first assistant message (cold turn, no cache yet) as the
    // reference for estimating how the input was composed.
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

    // Subagents: resolve each child session using task tool parts in this session
    const taskParts = parts.filter(
      (p): p is IPart & { data: IPartDataTask } =>
        p.data.type === "tool" &&
        (p.data as IPartDataTask).tool === "task",
    );
    const subagents = this.buildSubagentMetrics(taskParts, childSessions);

    // Live detection: has assistant message with no completion time
    const isLive =
      assistantMessages.some((m) => m.data.time?.completed === undefined && m.data.time?.created !== undefined) ||
      (session.time_updated > Date.now() - 30_000 && !lastCompleted);

    return {
      session,
      model_id: modelId,
      provider_id: providerId,
      agent,
      tokens,
      peak_turn_tokens: peakTurnTokens,
      token_composition: tokenComposition,
      context_limit: contextLimit,
      context_percentage: contextPercentage,
      peak_context_tokens: peakContextTokens,
      cost,
      finish_reason: finishReason,
      duration_total_ms: Math.max(0, durationTotalMs),
      duration_model_ms: Math.max(0, durationModelMs),
      injected_diffs_count: injectedDiffsCount,
      user_message_byte_size: userMsgByteSize,
      tool_calls_count: toolCallsCount,
      step_count: stepCount,
      subagents,
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
      // Sum only completed messages (total > 0 means it reported tokens)
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
   * Returns the ITokenMetrics for the single turn with the highest total,
   * along with the modelId of that turn.
   * This turn's tokens (input + output + cache_read) represent what actually
   * occupied the context window at peak usage — suitable for composition display.
   * peak_turn.total is also used as the context window usage metric.
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

  private sumCost(assistantMsgs: IMessage[]): number {
    return assistantMsgs.reduce((acc, m) => acc + (m.data.cost ?? 0), 0);
  }

  private getContextLimit(modelId: string): number {
    // Try exact match first, then partial match
    const exact = CONTEXT_LIMITS[modelId];
    if (exact !== undefined) return exact;

    const lower = modelId.toLowerCase();
    for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
      if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
        return limit;
      }
    }

    logger.debug("session-analyzer", `No context limit entry for model "${modelId}" — using default ${DEFAULT_CONTEXT_LIMIT}`);
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
    // The first assistant message is the "cold" turn where nothing is cached yet.
    // Its input tokens represent the actual tokens the model processed for the
    // first time: system prompt + auto-context diffs + user text.
    // Subsequent turns reuse cached context, so they don't help estimate composition.
    const coldInputTokens = firstAssistantMsg?.data.tokens?.input ?? 0;
    const coldTotal = firstAssistantMsg?.data.tokens
      ? (firstAssistantMsg.data.tokens.total ?? coldInputTokens)
      : 0;

    // User text: count characters only in text parts belonging to user messages.
    // Parts also exist on assistant messages (model responses), so we must
    // restrict to parts whose message_id matches a user message id.
    const userMessageIds = new Set(userMessages.map((m) => m.id));
    const userTextChars = parts
      .filter((p) => p.data.type === "text" && userMessageIds.has(p.message_id))
      .map((p) => (p.data.type === "text" ? p.data.text?.length ?? 0 : 0))
      .reduce((a, b) => a + b, 0);

    const userTextTokens = Math.min(Math.round(userTextChars / 4), coldInputTokens);

    // Auto-context: serialized diffs in user message data beyond user text
    const autoContextChars = Math.max(0, userMsgByteSize - userTextChars);
    const autoContextTokens =
      injectedDiffs > 0
        ? Math.min(Math.round(autoContextChars / 4), coldInputTokens - userTextTokens)
        : 0;

    // System prompt: remaining cold input after user text and auto-context
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

    // Session created
    push("session-created", session.time_created, "session-created", session.title);

    // User messages sent
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

    // Parts: step-start, step-finish, tool calls
    for (const part of parts) {
      if (part.data.type === "step-start") {
        push(
          part.id,
          part.time_created,
          "step-start",
          "timeline.step_start",
          part.data.snapshot?.slice(0, 8),
        );
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
          push(
            part.id,
            part.time_created,
            "tool-call",
            "timeline.tool_call",
            part.data.tool,
          );
        }
      }
    }

    // Model responses
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

    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);
    return events;
  }

  /**
   * Builds ISubagentMetrics for all completed task tool invocations.
   * Correlates each task part with its child session by sessionId in metadata.
   */
  private buildSubagentMetrics(
    taskParts: Array<IPart & { data: IPartDataTask }>,
    childSessions: Array<{ session: IDbSession; messages: IMessage[] }>,
  ): ISubagentMetrics[] {
    const results: ISubagentMetrics[] = [];

    for (const part of taskParts) {
      const state = part.data.state;
      // Only completed tasks have usable data
      if (state.status !== "completed") continue;

      const childSessionId = state.metadata?.sessionId;
      const agentType = state.input.subagent_type ?? "unknown";
      const description = state.input.description ?? "";
      const modelId = state.metadata?.model?.modelID ?? "unknown";

      // Compute duration from task tool timing
      const durationMs =
        state.time?.start !== undefined && state.time?.end !== undefined
          ? Math.max(0, state.time.end - state.time.start)
          : 0;

      // Find child session messages if available
      const childEntry = childSessions.find(
        (c) => c.session.id === childSessionId,
      );
      const childMessages = childEntry?.messages ?? [];
      const childAssistant = childMessages.filter(
        (m) => m.data.role === "assistant",
      );

      // Peak turn from child session (same logic as parent)
      const peakTurn = this.getPeakTurnTokens(childAssistant);
      const peakTokens = peakTurn.total;

      // Use child model for context limit; fall back to task metadata model
      const effectiveModel =
        peakTurn.modelId !== "unknown" ? peakTurn.modelId : modelId;
      const contextLimit = this.getContextLimit(effectiveModel);
      const contextPercentage =
        peakTokens > 0 ? Math.round((peakTokens / contextLimit) * 100) : 0;

      // Cost is sum across all child assistant messages
      const cost = this.sumCost(childAssistant);

      results.push({
        session_id: childSessionId ?? "",
        agent_type: agentType,
        description,
        model_id: effectiveModel,
        peak_tokens: peakTokens,
        context_limit: contextLimit,
        context_percentage: contextPercentage,
        cost,
        duration_ms: durationMs,
      });
    }

    return results;
  }
}
