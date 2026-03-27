import Anthropic from '@anthropic-ai/sdk';
import type { AgentMetadata } from '../types/agent.js';
import type { Task, TaskResult } from '../types/task.js';
import { BaseAgent } from './BaseAgent.js';

const CODE_SYSTEM_PROMPT = `You are Claude Code — an expert software engineer.
When given a coding task:
1. Analyse the requirements thoroughly.
2. Write clean, idiomatic code with inline comments where logic is non-obvious.
3. Include error handling appropriate to the context.
4. Provide a brief explanation of your solution after the code block.`;

export class ClaudeCodeAgent extends BaseAgent {
  readonly metadata: AgentMetadata = {
    id: 'claude-code',
    name: 'Claude Code (claude-sonnet-4-6 + tools)',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    capabilities: {
      textGeneration: true,
      codeExecution: true,
      codeGeneration: true,
      imageAnalysis: false,
      longContext: true,
      toolUse: true,
    },
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
    maxContextTokens: 200_000,
    timeoutMs: 90_000,
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
        max_tokens: 8192,
        system: CODE_SYSTEM_PROMPT,
        tools: [
          {
            name: 'bash',
            description: 'Run shell commands to test or verify code.',
            input_schema: {
              type: 'object' as const,
              properties: {
                command: { type: 'string', description: 'The shell command to run.' },
              },
              required: ['command'],
            },
          },
        ],
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
