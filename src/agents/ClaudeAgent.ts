import Anthropic from '@anthropic-ai/sdk';
import type { AgentMetadata } from '../types/agent.js';
import type { Task, TaskResult } from '../types/task.js';
import { BaseAgent } from './BaseAgent.js';

export class ClaudeAgent extends BaseAgent {
  readonly metadata: AgentMetadata = {
    id: 'claude',
    name: 'Claude (claude-sonnet-4-6)',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    capabilities: {
      textGeneration: true,
      codeExecution: false,
      codeGeneration: true,
      imageAnalysis: true,
      longContext: true,
      toolUse: true,
    },
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    maxContextTokens: 200_000,
    timeoutMs: 60_000,
  };

  private client: Anthropic;

  constructor() {
    super();
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.metadata.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: task.prompt }],
      });

      const content =
        response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('') ?? '';

      return {
        taskId: task.id,
        agentId: this.metadata.id,
        content,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - start,
        status: 'completed',
      };
    } catch (err) {
      return this.makeFailedResult(task, err);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!process.env.ANTHROPIC_API_KEY) return false;
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
