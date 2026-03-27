import type { AgentId, Provider } from './agent.js';

export interface CostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  estimatedOutputTokens: number;
}

export interface CostLedgerEntry {
  taskId: string;
  agentId: AgentId;
  provider: Provider;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;  // ISO 8601
}

export interface BudgetConfig {
  daily: {
    total: number;
    perAgent?: Partial<Record<AgentId, number>>;
  };
  monthly: {
    total: number;
  };
}
