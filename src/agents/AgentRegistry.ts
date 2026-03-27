import type { AgentId, TaskType } from '../types/agent.js';
import type { Task } from '../types/task.js';
import { BaseAgent } from './BaseAgent.js';
import { ClaudeAgent } from './ClaudeAgent.js';
import { ClaudeCodeAgent } from './ClaudeCodeAgent.js';
import { CodexAgent } from './CodexAgent.js';
import { GptAgent } from './GptAgent.js';
import { CursorAgent } from './CursorAgent.js';

// Task-type → preferred agent ordering
const TASK_TYPE_PREFERENCES: Record<TaskType, AgentId[]> = {
  code:     ['claude-code', 'codex', 'cursor', 'gpt', 'claude'],
  analysis: ['claude', 'gpt', 'claude-code', 'codex', 'cursor'],
  creative: ['gpt', 'claude', 'claude-code', 'codex', 'cursor'],
  general:  ['claude', 'gpt', 'claude-code', 'codex', 'cursor'],
};

export class AgentRegistry {
  private agents: Map<AgentId, BaseAgent>;
  private enabledIds: Set<AgentId>;

  constructor(enabledIds: AgentId[]) {
    this.enabledIds = new Set(enabledIds);
    this.agents = new Map([
      ['claude',      new ClaudeAgent()],
      ['claude-code', new ClaudeCodeAgent()],
      ['codex',       new CodexAgent()],
      ['gpt',         new GptAgent()],
      ['cursor',      new CursorAgent()],
    ]);
  }

  getAgent(id: AgentId): BaseAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  getEnabledAgents(): BaseAgent[] {
    return Array.from(this.agents.values()).filter((a) =>
      this.enabledIds.has(a.metadata.id),
    );
  }

  getPreferredOrder(task: Task): BaseAgent[] {
    const order = TASK_TYPE_PREFERENCES[task.type] ?? TASK_TYPE_PREFERENCES.general;
    return order
      .filter((id) => this.enabledIds.has(id))
      .map((id) => this.agents.get(id)!)
      .filter(Boolean);
  }

  async getAvailableAgents(): Promise<BaseAgent[]> {
    const enabled = this.getEnabledAgents();
    const checks = await Promise.all(
      enabled.map(async (agent) => ({
        agent,
        available: await agent.isAvailable(),
      })),
    );
    return checks.filter((c) => c.available).map((c) => c.agent);
  }
}
