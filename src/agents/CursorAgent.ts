import type { AgentMetadata } from '../types/agent.js';
import type { Task, TaskResult } from '../types/task.js';
import { BaseAgent } from './BaseAgent.js';

/**
 * Cursor Agent — STUB
 *
 * Cursor does not currently expose a public REST API for external orchestration.
 * This agent is disabled by default in control-tower.json.
 *
 * When Cursor releases a public API, implement `execute()` here using
 * the official SDK or REST client. Two possible approaches:
 *   (a) Cursor's official REST API (when available)
 *   (b) Local Cursor CLI / LSP sidecar for on-machine usage
 */
export class CursorAgent extends BaseAgent {
  readonly metadata: AgentMetadata = {
    id: 'cursor',
    name: 'Cursor AI (stub — not yet available)',
    provider: 'cursor',
    model: 'cursor-unknown',
    capabilities: {
      textGeneration: true,
      codeExecution: true,
      codeGeneration: true,
      imageAnalysis: false,
      longContext: false,
      toolUse: true,
    },
    costPer1kInputTokens: 0,
    costPer1kOutputTokens: 0,
    maxContextTokens: 64_000,
    timeoutMs: 60_000,
  };

  async execute(task: Task): Promise<TaskResult> {
    return {
      taskId: task.id,
      agentId: this.metadata.id,
      content: '',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: 'failed',
      error: 'Cursor does not have a public API yet. Agent is disabled.',
    };
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
