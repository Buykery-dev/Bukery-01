export type AgentId =
  | 'claude'
  | 'claude-code'
  | 'codex'
  | 'gpt'
  | 'cursor';

export type Provider = 'anthropic' | 'openai' | 'cursor';

export interface AgentCapability {
  textGeneration: boolean;
  codeExecution: boolean;
  codeGeneration: boolean;
  imageAnalysis: boolean;
  longContext: boolean;
  toolUse: boolean;
}

export interface AgentMetadata {
  id: AgentId;
  name: string;
  provider: Provider;
  model: string;
  capabilities: AgentCapability;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  maxContextTokens: number;
  timeoutMs: number;
}

export type ExecutionMode = 'single-best' | 'parallel-compare' | 'parallel-merge';

export type TaskType = 'code' | 'analysis' | 'creative' | 'general';
