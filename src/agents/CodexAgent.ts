import OpenAI from 'openai';
import type { AgentMetadata } from '../types/agent.js';
import type { Task, TaskResult } from '../types/task.js';
import { BaseAgent } from './BaseAgent.js';

/**
 * Codex Agent — uses OpenAI's o4-mini model optimised for reasoning and code.
 * "Codex" here refers to OpenAI's code-specialised lineage; the current best
 * model in that family is o4-mini (Apr 2025).
 */
export class CodexAgent extends BaseAgent {
  readonly metadata: AgentMetadata = {
    id: 'codex',
    name: 'Codex / o4-mini (OpenAI)',
    provider: 'openai',
    model: 'o4-mini',
    capabilities: {
      textGeneration: true,
      codeExecution: false,
      codeGeneration: true,
      imageAnalysis: false,
      longContext: false,
      toolUse: false,
    },
    costPer1kInputTokens: 0.0011,
    costPer1kOutputTokens: 0.0044,
    maxContextTokens: 128_000,
    timeoutMs: 90_000,
  };

  private client: OpenAI;

  constructor() {
    super();
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.metadata.model,
        messages: [{ role: 'user', content: task.prompt }],
        // o4-mini uses reasoning tokens; max_completion_tokens controls total
        max_completion_tokens: 8192,
      });

      const content = response.choices[0]?.message?.content ?? '';
      const usage = response.usage;

      return {
        taskId: task.id,
        agentId: this.metadata.id,
        content,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - start,
        status: 'completed',
      };
    } catch (err) {
      return this.makeFailedResult(task, err);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!process.env.OPENAI_API_KEY) return false;
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
