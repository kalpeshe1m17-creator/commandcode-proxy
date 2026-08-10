import { Readable } from 'node:stream';

export interface AccountInfo {
  id: string;
  name: string;
  apiKey: string;
  userId?: string;
  userName?: string;
  email?: string;
  addedAt: string;
}

export interface GatewayConfigFile {
  port?: number;
  activeAccountId?: string;
  rotationMode?: 'manual' | 'auto-quota' | string;
  permissionMode?: 'auto-accept' | 'standard' | 'plan' | 'bypass' | string;
  accounts?: AccountInfo[];
  upstream?: {
    apiBase?: string;
    ccVersion?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
  };
  endpoints?: Record<string, string>;
}

export interface GatewayConfig {
  port: number;
  activeAccountId: string;
  rotationMode: 'manual' | 'auto-quota' | string;
  permissionMode: string;
  accounts: AccountInfo[];
  ccApiBase: string;
  ccVersion: string;
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
  endpoints: Record<string, string>;
}

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  content?: string | any[] | null;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: any[];
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  response_format?: any;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string | number;
  thinking?: {
    type?: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | any[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | any[];
  max_tokens?: number;
  metadata?: any;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: any[];
  tool_choice?: any;
  thinking?: {
    type?: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
}

// Reverse-Engineered Official Command Code CLI Wire Protocol Schemas
export interface CCMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | CCContentPart[];
}

export interface CCContentPart {
  type: 'text' | 'reasoning' | 'image' | 'audio' | 'tool-call' | 'tool-result';
  text?: string;
  image?: string;
  audio?: { data: string; format: string };
  toolCallId?: string;
  toolName?: string;
  name?: string;
  arguments?: string;
  args?: unknown;
  input?: unknown;
  result?: string;
  output?: { type: 'text'; value: string } | unknown;
  isError?: boolean;
}

export interface CCTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export type CCToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'allowed_tools'; mode: 'auto' | 'none' | 'required'; tools: Array<{ type: 'function'; name: string }> };

export interface CCRequestBody {
  threadId?: string;
  mode?: string;
  config: {
    date: string;
    environment: string;
    workingDir: string;
    availableTools: any[];
    structure: any[];
    isGitRepo: boolean;
    currentBranch: string;
    mainBranch: string;
    gitStatus: string;
    recentCommits: string[];
    os?: string;
    shell?: string;
  };
  memory: string | null;
  taste: string | null;
  skills: string | null;
  permissionMode: 'auto-accept' | 'standard' | 'plan' | string;
  params: {
    model: string;
    messages: CCMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    stream: boolean;
    reasoning_effort?: string;
    tools?: CCTool[];
    tool_choice?: CCToolChoice;
    parallel_tool_calls?: boolean;
    response_format?: any;
    logit_bias?: Record<string, number>;
    n?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    user?: string;
  };
}

export interface CCEvent {
  type: 'start' | 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'tool-call' | 'finish' | 'finish-step' | 'error' | string;
  text?: string;
  toolCallId?: string;
  index?: number;
  name?: string;
  arguments?: string;
  input?: unknown;
  toolName?: string;
  finishReason?: string;
  error?: { message?: string; code?: string; type?: string; statusCode?: number };
  message?: string;
  data?: any;
}

export interface StreamEncoderState {
  id: string;
  created: number;
  toolCallIndex: number;
  toolCallIdToIndex: Map<string, number>;
  sawFinish: boolean;
  hasEmittedText: boolean;
  promptTokens: number;
  completionTokens: number;
  thinkingState: 'none' | 'in_think' | 'done';
}
