import TelegramBot from 'node-telegram-bot-api';
import type { IssueQueue } from '../queue/IssueQueue.js';
import type { DecisionEngine } from '../core/DecisionEngine.js';
import type { N8nClient } from '../n8n/N8nClient.js';
import { logger } from '../utils/logger.js';

/**
 * Handles Telegram inline keyboard button callbacks.
 *
 * Button actions registered here:
 *   codex_patch:<issueId>      — user requests Codex to generate a patch
 *   cowork_review:<issueId>    — user requests a human-facing code review
 *   approve_patch:<issueId>    — user approves patch → trigger merge via n8n
 *   reject_patch:<issueId>     — user rejects patch → re-open issue
 *   close_issue:<issueId>      — user closes issue without action
 *
 * Policy: no action here modifies production code directly.
 * All code changes are triggered via n8n, which requires PR creation
 * and a separate human merge approval step.
 */
export class CallbackQueryHandler {
  constructor(
    private bot: TelegramBot,
    private issueQueue: IssueQueue,
    private decisionEngine: DecisionEngine,
    private n8nClient: N8nClient,
  ) {}

  register(): void {
    this.bot.on('callback_query', async (query) => {
      if (!query.data) return;

      const colonIdx = query.data.indexOf(':');
      if (colonIdx === -1) return;

      const action = query.data.slice(0, colonIdx);
      const issueId = query.data.slice(colonIdx + 1);
      const chatId = query.message?.chat.id;

      try {
        await this.dispatch(action, issueId, chatId, query);
        await this.bot.answerCallbackQuery(query.id);
      } catch (err) {
        logger.error({ err, action, issueId }, 'Callback query handler error');
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Error processing action — check logs',
          show_alert: true,
        });
      }
    });
  }

  private async dispatch(
    action: string,
    issueId: string,
    chatId: number | undefined,
    query: TelegramBot.CallbackQuery,
  ): Promise<void> {
    switch (action) {
      case 'codex_patch':
        await this.handleCodexPatch(issueId, chatId, query);
        break;
      case 'cowork_review':
        await this.handleCoworkReview(issueId, chatId);
        break;
      case 'approve_patch':
        await this.handleApprovePatch(issueId, chatId, query);
        break;
      case 'reject_patch':
        await this.handleRejectPatch(issueId, chatId, query);
        break;
      case 'close_issue':
        await this.handleCloseIssue(issueId, chatId);
        break;
      default:
        logger.warn({ action, issueId }, 'Unknown callback action');
    }
  }

  private async handleCodexPatch(
    issueId: string,
    chatId: number | undefined,
    query: TelegramBot.CallbackQuery,
  ): Promise<void> {
    const issue = this.issueQueue.getById(issueId);
    if (!issue || !chatId) return;

    // Claude Code decides if patching is appropriate
    const decision = await this.decisionEngine.analyseIssue(issue);

    if (decision.assignTo !== 'codex' && decision.assignTo !== 'claude-code') {
      await this.bot.sendMessage(
        chatId,
        `Claude Code recommends: *${decision.recommendedAction}*\n\nNot routing to Codex: ${decision.summary}`,
        { parse_mode: 'MarkdownV2' },
      );
      return;
    }

    // Trigger n8n Codex Patch Flow
    await this.n8nClient.triggerPatchFlow(issue, decision);
    this.issueQueue.updateStatus(issueId, 'patch_requested', { decision });

    await this.bot.sendMessage(
      chatId,
      `Codex patch task queued for issue \`${issueId}\`\\. I'll notify when the PR is ready\\.`,
      { parse_mode: 'MarkdownV2' },
    );

    logger.info({ issueId, by: query.from.username }, 'Codex patch flow triggered');
  }

  private async handleCoworkReview(issueId: string, chatId: number | undefined): Promise<void> {
    const issue = this.issueQueue.getById(issueId);
    if (!issue || !chatId) return;

    await this.n8nClient.triggerReviewFlow(issue);
    await this.bot.sendMessage(
      chatId,
      `Cowork review request sent for issue \`${issueId}\`\\.`,
      { parse_mode: 'MarkdownV2' },
    );
  }

  private async handleApprovePatch(
    issueId: string,
    chatId: number | undefined,
    query: TelegramBot.CallbackQuery,
  ): Promise<void> {
    const issue = this.issueQueue.getById(issueId);
    if (!issue || !chatId) return;

    if (!issue.patchPrUrl) {
      await this.bot.sendMessage(chatId, 'No PR URL on record for this issue\\.', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    // Trigger merge via n8n — n8n will call GitHub API to merge the PR
    await this.n8nClient.triggerMergeFlow(issueId, issue.patchPrUrl, query.from.id);
    this.issueQueue.updateStatus(issueId, 'approved');

    await this.bot.sendMessage(
      chatId,
      `✅ Merge triggered for issue \`${issueId}\`\\. Approved by @${query.from.username ?? query.from.id}\\.`,
      { parse_mode: 'MarkdownV2' },
    );

    logger.info({ issueId, by: query.from.username }, 'Patch merge triggered');
  }

  private async handleRejectPatch(
    issueId: string,
    chatId: number | undefined,
    query: TelegramBot.CallbackQuery,
  ): Promise<void> {
    this.issueQueue.updateStatus(issueId, 'open');
    await this.n8nClient.notifyPatchRejected(issueId, query.from.id);

    if (chatId) {
      await this.bot.sendMessage(
        chatId,
        `Patch rejected by @${query.from.username ?? query.from.id}\\. Issue re\\-opened\\.`,
        { parse_mode: 'MarkdownV2' },
      );
    }
  }

  private async handleCloseIssue(issueId: string, chatId: number | undefined): Promise<void> {
    this.issueQueue.updateStatus(issueId, 'closed');
    if (chatId) {
      await this.bot.sendMessage(chatId, `Issue \`${issueId}\` closed\\.`, {
        parse_mode: 'MarkdownV2',
      });
    }
  }
}
