import type { IDbSession } from "./session.ts";

// Aggregated token usage for a session (sum of all assistant messages)

export interface ITokenMetrics {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

// One event in the session timeline

export type TimelineEventType =
  | "session-created"
  | "message-sent"
  | "step-start"
  | "tool-call"
  | "model-response"
  | "step-finish"
  | "patch";

export interface ITimelineEvent {
  id: string;
  timestamp: number;
  elapsed_ms: number; // relative to session creation
  type: TimelineEventType;
  label: string;
  detail?: string;
}

// Estimated breakdown of what consumed the cold-turn input tokens

export interface ITokenComposition {
  system_prompt_tokens: number; // estimated
  auto_context_tokens: number; // from summary diffs
  user_text_tokens: number; // from text parts
  total_input: number;
}

// Metrics for a subagent (child session) spawned via the task tool

export interface ISubagentMetrics {
  session_id: string;
  agent_type: string;        // "explore" | "general" | etc.
  description: string;       // from the task tool input.description
  model_id: string;
  peak_tokens: number;       // peak turn total in the child session
  context_limit: number;
  context_percentage: number;
  cost: number;
  duration_ms: number;       // from task tool state.time (start → end)
}

// Context window limits by model ID

export const CONTEXT_LIMITS: Record<string, number> = {
  "claude-haiku-4-5": 150000,
  "claude-haiku-4.5": 150000,
  "claude-sonnet-4-5": 200000,
  "claude-sonnet-4.5": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4.6": 200000,
  "claude-opus-4": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-haiku": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "o1": 128000,
  "o1-mini": 128000,
  "o3-mini": 128000,
};
export const DEFAULT_CONTEXT_LIMIT = 128000;

// Full computed metrics for a session — what the dashboard displays

export interface ISessionMetrics {
  session: IDbSession;

  // Identity
  model_id: string;
  provider_id: string;
  agent: string;

  // Tokens aggregated across all turns (useful for billing/cost totals)
  tokens: ITokenMetrics;
  // Tokens of the single peak turn (highest total). This represents the actual
  // context window state at its most occupied point: input, output, and cache_read
  // all belong to that one turn and sum to <= context_limit.
  peak_turn_tokens: ITokenMetrics;
  token_composition: ITokenComposition;

  // Context window
  context_limit: number;
  context_percentage: number;
  // Peak single-turn total (used for context bar display and "free tokens" calculation).
  // In multi-turn sessions each turn's total already includes cached prior context,
  // so this is max(total per turn) rather than sum(all totals).
  peak_context_tokens: number;

  // Costs & completion
  cost: number;
  finish_reason: string;

  // Timing
  duration_total_ms: number;
  duration_model_ms: number; // step-start to step-finish

  // Injected context metadata
  injected_diffs_count: number;
  user_message_byte_size: number;

  // Step counts
  tool_calls_count: number;
  step_count: number;

  // Subagents spawned by this session (child sessions via the task tool)
  subagents: ISubagentMetrics[];

  // Timeline
  timeline: ITimelineEvent[];

  // Live detection
  is_live: boolean;
}

// Compact summary used in the session list

export interface ISessionSummary {
  id: string;
  title: string;
  directory: string;
  model_id: string;
  provider_id: string;
  total_tokens: number;
  context_percentage: number;
  duration_ms: number;
  time_created: number;
  is_live: boolean;
  has_data: boolean; // false when session has no assistant messages yet
}
