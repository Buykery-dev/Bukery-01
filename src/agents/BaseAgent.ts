import type { AgentMetadata } from '../types/agent.js';
import type { Task, TaskResult } from '../types/task.js';
import type { CostEstimate } from '../types/cost.js';

export abstract class BaseAgent {
  abstract readonly metadata: AgentMetadata;

  /**
   * Execute a task and return the result.
   * Must never throw — return a failed TaskResult instead.
   */
  abstract execute(task: Task): Promise<TaskResult>;

  /**
   * Check whether the agent's API is currently reachable.
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Estimate the cost of executing a task before sending it.
   */
  estimateCost(task: Task): CostEstimate {
    const inputTokens = Math.ceil(task.prompt.length / 4);
    const estimatedOutputTokens = Math.min(inputTokens * 2, 1024);
    const inputCostUsd = (inputTokens / 1000) * this.metadata.costPer1kInputTokens;
    const outputCostUsd =
      (estimatedOutputTokens / 1000) * this.metadata.costPer1kOutputTokens;
    return {
      inputCostUsd,
      outputCostUsd,
      totalCostUsd: inputCostUsd + outputCostUsd,
      estimatedOutputTokens,
    };
  }

  protected makeFailedResult(task: Task, error: unknown): TaskResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      taskId: task.id,
      agentId: this.metadata.id,
      content: '',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: 'failed',
      error: message,
    };
  }
}
