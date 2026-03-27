import type { TelegramTaskPayload } from '../types/webhook.js';
import type { ControlTower } from '../core/ControlTower.js';
import { TelegramFormatter } from '../gateway/TelegramFormatter.js';
import { logger } from '../utils/logger.js';
import TelegramBot from 'node-telegram-bot-api';

/**
 * CommandFlow
 *
 * Handles manual Telegram commands forwarded by n8n.
 * Claude Code (via ControlTower) decides routing and executes the task.
 */
export class CommandFlow {
  constructor(
    private controlTower: ControlTower,
    private formatter: TelegramFormatter,
    private bot: TelegramBot,
  ) {}

  async handle(payload: TelegramTaskPayload): Promise<{ status: string }> {
    const { prompt, chatId, messageId } = payload;

    logger.info({ chatId, promptPreview: prompt.slice(0, 80) }, 'CommandFlow: handling task');

    const task = this.controlTower.buildTask(prompt, {
      telegramChatId: chatId,
      telegramMessageId: messageId,
    });

    try {
      const result = await this.controlTower.execute(task);
      const text = this.formatter.format(result);
      const chunks = this.formatter.splitMessage(text);

      for (const chunk of chunks) {
        await this.bot.sendMessage(chatId, chunk, {
          parse_mode: 'MarkdownV2',
          ...(messageId ? { reply_to_message_id: messageId } : {}),
        });
      }
      return { status: 'done' };
    } catch (err) {
      const errText = this.formatter.formatError(err);
      await this.bot.sendMessage(chatId, errText, { parse_mode: 'MarkdownV2' });
      return { status: 'error' };
    }
  }
}
