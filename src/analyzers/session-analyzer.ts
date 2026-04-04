import type { IDbSession, IMessage, IPart, ITokens, IPartDataStepFinish } from "../models/session.ts";
import {
  CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  type ISessionMetrics,
  type ISessionSummary,
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
    const contextLimit = this.getContextLimit(modelId);
    const contextPercentage =
      tokens.total > 0 ? Math.round((tokens.total / contextLimit) * 100) : 0;

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
    const tokenComposition = this.estimateComposition(
      tokens,
      parts,
      userMessages,
      injectedDiffsCount,
      userMsgByteSize,
    );

    // Timeline
    const timeline = this.buildTimeline(session, messages, parts);

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
      token_composition: tokenComposition,
      context_limit: contextLimit,
      context_percentage: contextPercentage,
      cost,
      finish_reason: finishReason,
      duration_total_ms: Math.max(0, durationTotalMs),
      duration_model_ms: Math.max(0, durationModelMs),
      injected_diffs_count: injectedDiffsCount,
      user_message_byte_size: userMsgByteSize,
      tool_calls_count: toolCallsCount,
      step_count: stepCount,
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
    tokens: ITokenMetrics,
    parts: IPart[],
    userMessages: IMessage[],
    injectedDiffs: number,
    userMsgByteSize: number,
  ): ITokenComposition {
    // User text: count characters in all text parts from user messages
    const userTextChars = parts
      .filter((p) => p.data.type === "text")
      .map((p) => (p.data.type === "text" ? p.data.text?.length ?? 0 : 0))
      .reduce((a, b) => a + b, 0);

    const userTextTokens = Math.round(userTextChars / 4);

    // Auto-context: serialized diffs in user message data beyond user text
    // Estimated as: (total user message data - user text) / 4 chars per token
    const autoContextChars = Math.max(0, userMsgByteSize - userTextChars);
    const autoContextTokens =
      injectedDiffs > 0 ? Math.round(autoContextChars / 4) : 0;

    // System prompt: remaining input tokens
    const systemPromptTokens = Math.max(
      0,
      tokens.input - userTextTokens - autoContextTokens,
    );

    return {
      system_prompt_tokens: systemPromptTokens,
      auto_context_tokens: autoContextTokens,
      user_text_tokens: userTextTokens,
      total_input: tokens.input,
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
}
