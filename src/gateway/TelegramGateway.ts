import fs from 'node:fs';
import TelegramBot from 'node-telegram-bot-api';
import type { AgentId, ExecutionMode, TaskType } from '../types/agent.js';
import { ControlTower } from '../core/ControlTower.js';
import { TelegramFormatter } from './TelegramFormatter.js';
import { logger } from '../utils/logger.js';

interface OpenclawConfig {
  channels: {
    telegram: {
      groupAllowFrom: string[];
    };
  };
}

interface ParsedCommand {
  executionMode: ExecutionMode;
  taskType?: TaskType;
  preferredAgents?: AgentId[];
  prompt: string;
}

export class TelegramGateway {
  private bot: TelegramBot;
  private allowedGroups: Set<string>;
  private controlTower: ControlTower;
  private formatter: TelegramFormatter;

  constructor(token: string, openclawPath: string, controlTower: ControlTower) {
    this.bot = new TelegramBot(token, { polling: true });
    this.allowedGroups = this.loadAllowedGroups(openclawPath);
    this.controlTower = controlTower;
    this.formatter = new TelegramFormatter();

    logger.info({ groups: [...this.allowedGroups] }, 'Telegram gateway initialised');
    this.registerHandlers();
  }

  private loadAllowedGroups(openclawPath: string): Set<string> {
    try {
      const raw = fs.readFileSync(openclawPath, 'utf-8');
      const config = JSON.parse(raw) as OpenclawConfig;
      return new Set(config.channels.telegram.groupAllowFrom);
    } catch (err) {
      logger.warn({ err }, 'Failed to load openclaw.json — no groups allowed');
      return new Set();
    }
  }

  private registerHandlers(): void {
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text?.trim();

      if (!text || !this.isAllowed(chatId)) return;
      if (text.startsWith('/start') || text.startsWith('/help')) {
        await this.sendHelp(chatId);
        return;
      }

      await this.handleTask(msg, text);
    });

    this.bot.on('polling_error', (err) => {
      logger.error({ err }, 'Telegram polling error');
    });
  }

  private isAllowed(chatId: number): boolean {
    return this.allowedGroups.has(String(chatId));
  }

  private async handleTask(
    msg: TelegramBot.Message,
    text: string,
  ): Promise<void> {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    const parsed = this.parseCommand(text);
    const task = this.controlTower.buildTask(parsed.prompt, {
      executionMode: parsed.executionMode,
      taskType: parsed.taskType,
      preferredAgents: parsed.preferredAgents,
      telegramChatId: chatId,
      telegramMessageId: messageId,
    });

    // Send "processing" status
    const agentCount = parsed.executionMode === 'single-best' ? 1 : 5;
    await this.bot.sendMessage(
      chatId,
      this.formatter.formatProcessing(agentCount, parsed.executionMode),
      { parse_mode: 'MarkdownV2', reply_to_message_id: messageId },
    );

    try {
      const result = await this.controlTower.execute(task);
      const formatted = this.formatter.format(result);
      const chunks = this.formatter.splitMessage(formatted);

      for (const chunk of chunks) {
        await this.bot.sendMessage(chatId, chunk, {
          parse_mode: 'MarkdownV2',
          reply_to_message_id: messageId,
        });
      }
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Task execution failed');
      await this.bot.sendMessage(chatId, this.formatter.formatError(err), {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: messageId,
      });
    }
  }

  /**
   * Parse optional command prefixes from user messages:
   *   /compare <prompt>     → parallel-compare mode
   *   /merge <prompt>       → parallel-merge mode
   *   /code <prompt>        → code task, best code agents
   *   /cheap <prompt>       → single-best, cost-optimised
   *   /claude <prompt>      → force Claude only
   *   /gpt <prompt>         → force GPT only
   *   <anything else>       → single-best, auto-detected type
   */
  private parseCommand(text: string): ParsedCommand {
    const matchers: Array<{
      pattern: RegExp;
      result: Omit<ParsedCommand, 'prompt'>;
    }> = [
      {
        pattern: /^\/compare\s+/i,
        result: { executionMode: 'parallel-compare' },
      },
      {
        pattern: /^\/merge\s+/i,
        result: { executionMode: 'parallel-merge' },
      },
      {
        pattern: /^\/code\s+/i,
        result: {
          executionMode: 'single-best',
          taskType: 'code',
          preferredAgents: ['claude-code', 'codex'],
        },
      },
      {
        pattern: /^\/cheap\s+/i,
        result: {
          executionMode: 'single-best',
          preferredAgents: ['codex', 'claude'],
        },
      },
      {
        pattern: /^\/claude\s+/i,
        result: { executionMode: 'single-best', preferredAgents: ['claude'] },
      },
      {
        pattern: /^\/gpt\s+/i,
        result: { executionMode: 'single-best', preferredAgents: ['gpt'] },
      },
    ];

    for (const { pattern, result } of matchers) {
      if (pattern.test(text)) {
        return { ...result, prompt: text.replace(pattern, '').trim() };
      }
    }

    return { executionMode: 'single-best', prompt: text };
  }

  private async sendHelp(chatId: number): Promise<void> {
    const help = [
      '*🗼 Bukery Control Tower*',
      'Orchestrate Claude, Claude Code, Codex, GPT\\-4o in one command\\.',
      '',
      '*Commands:*',
      '`/compare <question>` — run all agents, show comparison',
      '`/merge <question>` — run top\\-3, synthesise best answer',
      '`/code <task>` — route to code\\-specialised agents',
      '`/cheap <question>` — use cheapest available agent',
      '`/claude <question>` — force Claude only',
      '`/gpt <question>` — force GPT\\-4o only',
      '`<any message>` — auto\\-route to best agent',
    ].join('\n');

    await this.bot.sendMessage(chatId, help, { parse_mode: 'MarkdownV2' });
  }

  stop(): void {
    this.bot.stopPolling();
    logger.info('Telegram gateway stopped');
  }
}
