import pLimit from 'p-limit';
import type { Task, TaskResult } from '../types/task.js';
import type { BaseAgent } from '../agents/BaseAgent.js';

export class ParallelExecutor {
  private concurrencyLimit: number;

  constructor(maxConcurrent = 3) {
    this.concurrencyLimit = maxConcurrent;
  }

  /**
   * Execute a task on all given agents in parallel.
   * Uses Promise.allSettled — a single agent failure never aborts the others.
   */
  async executeAll(task: Task, agents: BaseAgent[]): Promise<TaskResult[]> {
    const limit = pLimit(this.concurrencyLimit);

    const promises = agents.map((agent) =>
      limit(async () => {
        try {
          const timeoutPromise = new Promise<TaskResult>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout after ${agent.metadata.timeoutMs}ms`)),
              agent.metadata.timeoutMs,
            ),
          );
          return await Promise.race([agent.execute(task), timeoutPromise]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            taskId: task.id,
            agentId: agent.metadata.id,
            content: '',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: agent.metadata.timeoutMs,
            status: 'failed' as const,
            error: message,
          };
        }
      }),
    );

    const settled = await Promise.allSettled(promises);
    return settled.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            taskId: task.id,
            agentId: 'claude' as const,  // fallback label — should not happen
            content: '',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            status: 'failed' as const,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  }

  /**
   * Execute on a single agent (the first in the list).
   */
  async executeSingle(task: Task, agent: BaseAgent): Promise<TaskResult> {
    const results = await this.executeAll(task, [agent]);
    return results[0]!;
  }
}
