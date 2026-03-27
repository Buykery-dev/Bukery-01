import OpenAI from 'openai';
import type { AgentMetadata } from '../types/agent.js';
import type { Task, TaskResult } from '../types/task.js';
import { BaseAgent } from './BaseAgent.js';

export class GptAgent extends BaseAgent {
  readonly metadata: AgentMetadata = {
    id: 'gpt',
    name: 'GPT-4o (OpenAI)',
    provider: 'openai',
    model: 'gpt-4o',
    capabilities: {
      textGeneration: true,
      codeExecution: false,
      codeGeneration: true,
      imageAnalysis: true,
      longContext: true,
      toolUse: true,
    },
    costPer1kInputTokens: 0.005,
    costPer1kOutputTokens: 0.015,
    maxContextTokens: 128_000,
    timeoutMs: 60_000,
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
        max_tokens: 4096,
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
