import { v4 as uuidv4 } from 'uuid';
import type { Task, OrchestratedResult, TaskResult } from '../types/task.js';
import type { AgentId, ExecutionMode, TaskType } from '../types/agent.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { TaskRouter } from './TaskRouter.js';
import { ParallelExecutor } from './ParallelExecutor.js';
import { ResultEvaluator } from './ResultEvaluator.js';
import { CostTracker } from './CostTracker.js';
import { logger } from '../utils/logger.js';

export interface ControlTowerOptions {
  registry: AgentRegistry;
  router: TaskRouter;
  executor: ParallelExecutor;
  evaluator: ResultEvaluator;
  costTracker: CostTracker;
}

export class ControlTower {
  private registry: AgentRegistry;
  private router: TaskRouter;
  private executor: ParallelExecutor;
  private evaluator: ResultEvaluator;
  private costTracker: CostTracker;

  constructor(opts: ControlTowerOptions) {
    this.registry = opts.registry;
    this.router = opts.router;
    this.executor = opts.executor;
    this.evaluator = opts.evaluator;
    this.costTracker = opts.costTracker;
  }

  async execute(task: Task): Promise<OrchestratedResult> {
    const start = Date.now();
    logger.info({ taskId: task.id, type: task.type, mode: task.executionMode }, 'Task received');

    const availableAgents = await this.registry.getAvailableAgents();
    if (availableAgents.length === 0) {
      throw new Error('No AI agents are currently available. Check your API keys.');
    }

    const rankedAgents = await this.router.rank(task, availableAgents);
    if (rankedAgents.length === 0) {
      throw new Error('All agents are over budget or filtered by task constraints.');
    }

    let allResults: TaskResult[];

    switch (task.executionMode) {
      case 'single-best': {
        const agent = rankedAgents[0]!;
        logger.info({ agentId: agent.metadata.id }, 'Single-best: routing to agent');
        const result = await this.executor.executeSingle(task, agent);
        allResults = [result];
        break;
      }

      case 'parallel-compare': {
        logger.info({ count: rankedAgents.length }, 'Parallel-compare: running all agents');
        allResults = await this.executor.executeAll(task, rankedAgents);
        break;
      }

      case 'parallel-merge': {
        // Run top-3 agents, then synthesise via the best available judge
        const subset = rankedAgents.slice(0, 3);
        logger.info({ count: subset.length }, 'Parallel-merge: running subset then synthesising');
        const subResults = await this.executor.executeAll(task, subset);
        const synthesised = await this.synthesise(task, subResults, rankedAgents);
        allResults = [...subResults, synthesised];
        break;
      }
    }

    // Record costs
    for (const result of allResults) {
      this.costTracker.record(result);
    }

    const totalCostUsd = allResults.reduce(
      (sum, r) => sum + this.costTracker.getCostForResult(r),
      0,
    );

    const winner = this.evaluator.pickWinner(allResults);
    if (!winner) {
      throw new Error('All agents failed. Check individual errors in allResults.');
    }

    const orchestrated: OrchestratedResult = {
      taskId: task.id,
      winner,
      allResults,
      executionMode: task.executionMode,
      totalCostUsd,
      totalLatencyMs: Date.now() - start,
    };

    logger.info(
      {
        taskId: task.id,
        winner: winner.agentId,
        costUsd: totalCostUsd.toFixed(4),
        latencyMs: orchestrated.totalLatencyMs,
      },
      'Task completed',
    );

    return orchestrated;
  }

  /**
   * Build a Task object from a raw user message (e.g. from Telegram).
   */
  buildTask(
    prompt: string,
    overrides?: {
      type?: TaskType;
      executionMode?: ExecutionMode;
      preferredAgents?: AgentId[];
      telegramChatId?: number;
      telegramMessageId?: number;
    },
  ): Task {
    return {
      id: uuidv4(),
      prompt,
      type: overrides?.type ?? this.detectTaskType(prompt),
      executionMode: overrides?.executionMode ?? 'single-best',
      preferredAgents: overrides?.preferredAgents,
      telegramChatId: overrides?.telegramChatId,
      telegramMessageId: overrides?.telegramMessageId,
      createdAt: new Date(),
    };
  }

  private detectTaskType(prompt: string): TaskType {
    const lower = prompt.toLowerCase();
    if (
      /\b(code|function|class|implement|algorithm|bug|fix|typescript|javascript|python|sql|api)\b/.test(lower)
    )
      return 'code';
    if (
      /\b(analyse|analyze|explain|compare|evaluate|review|summarise|summarize|research)\b/.test(lower)
    )
      return 'analysis';
    if (/\b(write|story|poem|creative|essay|blog|marketing|copy)\b/.test(lower))
      return 'creative';
    return 'general';
  }

  private async synthesise(
    originalTask: Task,
    subResults: TaskResult[],
    rankedAgents: ReturnType<AgentRegistry['getPreferredOrder']>,
  ): Promise<TaskResult> {
    const successfulResults = subResults.filter((r) => r.status === 'completed');
    if (successfulResults.length === 0) {
      return {
        taskId: originalTask.id,
        agentId: 'claude',
        content: '',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        status: 'failed',
        error: 'No successful results to synthesise from.',
      };
    }

    const judgeAgent = rankedAgents.find((a) => a.metadata.id === 'claude') ?? rankedAgents[0]!;

    const answerBlocks = successfulResults
      .map((r) => `### ${r.agentId}\n${r.content}`)
      .join('\n\n---\n\n');

    const synthesisPrompt = `You are a synthesis judge. Multiple AI assistants have answered the following question:\n\n"${originalTask.prompt}"\n\nHere are their responses:\n\n${answerBlocks}\n\nPlease synthesise the best combined answer, incorporating the strongest points from each response. Do not mention which assistant said what.`;

    const synthesisTask: Task = {
      ...originalTask,
      id: uuidv4(),
      prompt: synthesisPrompt,
    };

    const result = await judgeAgent.execute(synthesisTask);
    return { ...result, taskId: originalTask.id, agentId: 'claude' };
  }
}
