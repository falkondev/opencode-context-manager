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

// Detailed info for a single tool call

export interface IToolDetail {
  call_id: string;
  tool_name: string;            // "bash", "read", "glob", "task", etc.
  tool_owner: string;           // "Built-in" | "MCP: <server name>"
  status: string;               // "completed" | "running" | "error"
  title: string;                // Human-readable description
  duration_ms: number;
  has_error: boolean;
  input_summary: string;        // First ~100 chars of serialized input
  output_summary: string;       // First ~100 chars of output
}

// Aggregated tool usage stats (grouped by tool_name)

export interface IToolAggregation {
  tool_name: string;
  tool_owner: string;
  total_calls: number;
  completed_calls: number;
  error_count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
}

// Per-step detailed metrics (one step = one assistant message / LLM inference)

export interface IStepMetrics {
  step_number: number;          // 1-indexed
  message_id: string;
  timestamp: number;            // time_created of the assistant message
  duration_ms: number;          // time.completed - time.created

  // Token breakdown for THIS step
  tokens: {
    total: number;              // Context window size in this step (grows across steps)
    input: number;              // Fresh tokens (non-cached) — real cost
    output: number;             // Tokens generated
    reasoning: number;
    cache_read: number;         // Reused from prior step via cache — "free"
    cache_write: number;        // Written to cache for next step
  };

  // Context window info
  context_limit: number;
  context_percentage: number;   // total / limit * 100

  // Delta vs previous step
  context_growth: number;       // total[n] - total[n-1] (0 for first step)
  cache_efficiency: number;     // cache_read / (cache_read + input) * 100

  // Tools called during this step
  tool_calls: IToolDetail[];

  cost: number;
  finish_reason: string;        // "tool-calls" | "stop" | "unknown"
}

// Metrics for a subagent (child session) spawned via the task tool

export interface ISubagentMetrics {
  session_id: string;
  agent_type: string;           // "explore" | "general" | etc.
  description: string;          // from the task tool input.description
  model_id: string;
  peak_tokens: number;          // peak turn total in the child session
  context_limit: number;
  context_percentage: number;
  cost: number;
  duration_ms: number;          // from task tool state.time (start → end)
}

// Detailed subagent metrics with full step/tool breakdown

export interface ISubagentDetail extends ISubagentMetrics {
  steps: IStepMetrics[];                    // All steps inside the subagent
  tools_aggregation: IToolAggregation[];    // Tool stats aggregated
  tokens_billing: ITokenMetrics;            // Billing totals for the subagent
  cache_efficiency: number;                 // Overall cache efficiency %
  shared_context_tokens: number;            // Tokens from parent context (first step input)
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
  // context window state at its most occupied point.
  peak_turn_tokens: ITokenMetrics;

  // Tokens of the LAST completed step (current context window state)
  last_step_tokens: ITokenMetrics;

  token_composition: ITokenComposition;

  // Context window (based on peak turn for maximum usage display)
  context_limit: number;
  context_percentage: number;
  peak_context_tokens: number;

  // Context based on last step (current state)
  last_step_context_percentage: number;

  // Billing aggregates (sum across all steps — real cost breakdown)
  total_fresh_input: number;          // sum of input (non-cached) across all steps
  total_cache_reused: number;         // sum of cache_read across all steps
  overall_cache_efficiency: number;   // total_cache_reused / (total_cache_reused + total_fresh_input) * 100

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

  // Detailed step-by-step data (for Steps overlay)
  steps: IStepMetrics[];

  // All tool calls with details (for Tools overlay)
  tools_detail: IToolDetail[];

  // Tool usage aggregated by tool name (for Tools overlay summary)
  tools_aggregation: IToolAggregation[];

  // Subagents spawned by this session (basic metrics for token panel)
  subagents: ISubagentMetrics[];

  // Detailed subagent data (for Subagents overlay — loaded on demand)
  subagent_details: ISubagentDetail[];

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
