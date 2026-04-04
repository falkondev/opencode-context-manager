// Raw rows returned from the SQLite database (all decoded from JSON data fields)

export interface IDbSession {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string;
  version: string;
  share_url: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  summary_diffs: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  workspace_id: string | null;
}

export interface IDbMessageRaw {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string; // raw JSON
}

export interface IDbPartRaw {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string; // raw JSON
}

// Parsed structures from the JSON `data` field of message rows

export interface ITokenCache {
  read: number;
  write: number;
}

export interface ITokens {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: ITokenCache;
}

export interface IMessageModel {
  providerID: string;
  modelID: string;
}

export interface IDiff {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface ISummary {
  diffs: IDiff[];
}

export interface IMessageData {
  role: "user" | "assistant";
  agent: string;
  mode?: string;
  parentID?: string;
  model?: IMessageModel;
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: ITokens;
  time?: { created?: number; completed?: number };
  finish?: string;
  summary?: ISummary;
  variant?: string;
  path?: { cwd: string; root: string };
}

// Parsed structures from the JSON `data` field of part rows

export interface IPartDataText {
  type: "text";
  text: string;
  time?: { start?: number; end?: number };
}

export interface IPartDataStepStart {
  type: "step-start";
  snapshot: string;
}

export interface IPartDataStepFinish {
  type: "step-finish";
  snapshot: string;
  reason: string;
  tokens: ITokens;
  cost: number;
}

export interface IPartDataTool {
  type: "tool";
  tool: string;
  callID: string;
  state: {
    status: "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    time?: { start?: number; end?: number };
  };
}

export interface IPartDataPatch {
  type: "patch";
  diffs?: unknown[];
}

// Task tool invocation — spawns a subagent session
export interface IPartDataTaskInput {
  description: string;
  prompt: string;
  subagent_type: string; // "explore" | "general" | etc.
  task_id?: string;      // present when resuming a previous subagent session
}

export interface IPartDataTaskMetadata {
  sessionId: string; // the child session ID
  model: { modelID: string; providerID: string };
  truncated?: boolean;
}

export interface IPartDataTask {
  type: "tool";
  tool: "task";
  callID: string;
  state: {
    status: "running" | "completed" | "error";
    input: IPartDataTaskInput;
    output?: string;
    error?: string;
    metadata?: IPartDataTaskMetadata;
    title?: string;
    time?: { start?: number; end?: number };
  };
}

export type IPartData =
  | IPartDataText
  | IPartDataStepStart
  | IPartDataStepFinish
  | IPartDataTool
  | IPartDataTask
  | IPartDataPatch;

// Enriched message with parsed data

export interface IMessage {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: IMessageData;
}

// Enriched part with parsed data

export interface IPart {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: IPartData;
}
