import fs from 'node:fs';
import type { AgentId } from '../types/agent.js';
import type { BudgetConfig, CostLedgerEntry } from '../types/cost.js';
import type { TaskResult } from '../types/task.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';

export class CostTracker {
  private ledger: CostLedgerEntry[] = [];
  private ledgerPath: string;
  private budget: BudgetConfig;
  private registry: AgentRegistry;

  constructor(ledgerPath: string, budget: BudgetConfig, registry: AgentRegistry) {
    this.ledgerPath = ledgerPath;
    this.budget = budget;
    this.registry = registry;
    this.load();
  }

  record(result: TaskResult): void {
    if (result.status !== 'completed') return;
    const agent = this.registry.getAgent(result.agentId);
    const { costPer1kInputTokens, costPer1kOutputTokens, provider } = agent.metadata;
    const costUsd =
      (result.inputTokens / 1000) * costPer1kInputTokens +
      (result.outputTokens / 1000) * costPer1kOutputTokens;

    this.ledger.push({
      taskId: result.taskId,
      agentId: result.agentId,
      provider,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      timestamp: new Date().toISOString(),
    });

    this.persist();
  }

  getCostForResult(result: TaskResult): number {
    const agent = this.registry.getAgent(result.agentId);
    return (
      (result.inputTokens / 1000) * agent.metadata.costPer1kInputTokens +
      (result.outputTokens / 1000) * agent.metadata.costPer1kOutputTokens
    );
  }

  isAgentOverBudget(agentId: AgentId): boolean {
    const today = new Date().toISOString().slice(0, 10);
    const dailyTotal = this.ledger
      .filter((e) => e.timestamp.startsWith(today))
      .reduce((s, e) => s + e.costUsd, 0);

    if (dailyTotal >= this.budget.daily.total) return true;

    const agentDailyLimit = this.budget.daily.perAgent?.[agentId];
    if (agentDailyLimit !== undefined) {
      const agentToday = this.ledger
        .filter((e) => e.timestamp.startsWith(today) && e.agentId === agentId)
        .reduce((s, e) => s + e.costUsd, 0);
      if (agentToday >= agentDailyLimit) return true;
    }

    return false;
  }

  getDailySummary(): string {
    const today = new Date().toISOString().slice(0, 10);
    const entries = this.ledger.filter((e) => e.timestamp.startsWith(today));
    const total = entries.reduce((s, e) => s + e.costUsd, 0);
    const perAgent = entries.reduce<Partial<Record<AgentId, number>>>((acc, e) => {
      acc[e.agentId] = (acc[e.agentId] ?? 0) + e.costUsd;
      return acc;
    }, {});

    const lines = Object.entries(perAgent).map(
      ([id, cost]) => `  ${id}: $${(cost ?? 0).toFixed(4)}`,
    );
    return `Daily spend: $${total.toFixed(4)}\n${lines.join('\n')}`;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
        this.ledger = JSON.parse(raw) as CostLedgerEntry[];
      }
    } catch {
      this.ledger = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2));
    } catch {
      // non-fatal — best effort persistence
    }
  }
}
