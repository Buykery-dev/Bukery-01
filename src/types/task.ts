import type { AgentId, ExecutionMode, TaskType } from './agent.js';

export interface Task {
  id: string;
  prompt: string;
  type: TaskType;
  executionMode: ExecutionMode;
  preferredAgents?: AgentId[];
  telegramChatId?: number;
  telegramMessageId?: number;
  createdAt: Date;
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskResult {
  taskId: string;
  agentId: AgentId;
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: TaskStatus;
  error?: string;
}

export interface OrchestratedResult {
  taskId: string;
  winner: TaskResult;
  allResults: TaskResult[];
  executionMode: ExecutionMode;
  totalCostUsd: number;
  totalLatencyMs: number;
}
