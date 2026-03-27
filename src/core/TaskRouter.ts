import type { AgentId } from '../types/agent.js';
import type { Task } from '../types/task.js';
import type { BaseAgent } from '../agents/BaseAgent.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { CostTracker } from './CostTracker.js';

interface AgentScore {
  agent: BaseAgent;
  score: number;
}

export class TaskRouter {
  private registry: AgentRegistry;
  private costTracker: CostTracker;

  constructor(registry: AgentRegistry, costTracker: CostTracker) {
    this.registry = registry;
    this.costTracker = costTracker;
  }

  /**
   * Returns agents sorted by suitability for the task (best first).
   * Agents over budget or not available are excluded.
   */
  async rank(task: Task, availableAgents: BaseAgent[]): Promise<BaseAgent[]> {
    const preferred = this.registry.getPreferredOrder(task).map((a) => a.metadata.id);

    const scored: AgentScore[] = availableAgents
      .filter((a) => !this.costTracker.isAgentOverBudget(a.metadata.id))
      .filter((a) => {
        // Filter by explicit preferred agents if the task specifies them
        if (task.preferredAgents && task.preferredAgents.length > 0) {
          return task.preferredAgents.includes(a.metadata.id as AgentId);
        }
        return true;
      })
      .map((agent) => ({
        agent,
        score: this.scoreAgent(agent, task, preferred),
      }));

    return scored.sort((a, b) => b.score - a.score).map((s) => s.agent);
  }

  private scoreAgent(agent: BaseAgent, task: Task, preferenceOrder: AgentId[]): number {
    let score = 0;

    // Capability match (weight: 0.5)
    score += this.capabilityScore(agent, task) * 0.5;

    // Preference order position (weight: 0.3)
    const pos = preferenceOrder.indexOf(agent.metadata.id);
    if (pos !== -1) {
      score += ((preferenceOrder.length - pos) / preferenceOrder.length) * 0.3;
    }

    // Cost optimisation (weight: 0.2) — cheaper is better
    const maxCost = 0.02;  // normalise against $0.02/1k output tokens
    const costRatio = Math.min(agent.metadata.costPer1kOutputTokens / maxCost, 1);
    score += (1 - costRatio) * 0.2;

    return score;
  }

  private capabilityScore(agent: BaseAgent, task: Task): number {
    const caps = agent.metadata.capabilities;
    switch (task.type) {
      case 'code':
        return (
          (caps.codeGeneration ? 0.5 : 0) +
          (caps.codeExecution ? 0.3 : 0) +
          (caps.toolUse ? 0.2 : 0)
        );
      case 'analysis':
        return (
          (caps.textGeneration ? 0.4 : 0) +
          (caps.longContext ? 0.4 : 0) +
          (caps.toolUse ? 0.2 : 0)
        );
      case 'creative':
        return caps.textGeneration ? 1.0 : 0;
      default:
        return caps.textGeneration ? 0.8 : 0;
    }
  }
}
