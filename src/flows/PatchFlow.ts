import type { CodexPatchCompletePayload, PatchDecisionPayload } from '../types/webhook.js';
import { IssueQueue } from '../queue/IssueQueue.js';
import { DecisionEngine } from '../core/DecisionEngine.js';
import { TelegramFormatter } from '../gateway/TelegramFormatter.js';
import { N8nClient } from '../n8n/N8nClient.js';
import { logger } from '../utils/logger.js';
import TelegramBot from 'node-telegram-bot-api';

/**
 * PatchFlow
 *
 * Handles two events:
 *  1. Codex has finished generating a patch (POST /webhook/codex-patch-complete)
 *     → Claude Code reviews it → send approve/reject to Telegram
 *
 *  2. Human approved or rejected via Telegram button (POST /webhook/patch-decision)
 *     → Trigger merge via n8n, or re-open issue
 *
 * Policy: no auto-merge.  Human must click Approve in Telegram.
 */
export class PatchFlow {
  constructor(
    private issueQueue: IssueQueue,
    private decisionEngine: DecisionEngine,
    private formatter: TelegramFormatter,
    private bot: TelegramBot,
    private n8nClient: N8nClient,
    private alertChatId: number,
  ) {}

  async handlePatchComplete(payload: CodexPatchCompletePayload): Promise<{ status: string }> {
    const issue = this.issueQueue.getById(payload.issueId);
    if (!issue) {
      logger.warn({ issueId: payload.issueId }, 'PatchFlow: issue not found');
      return { status: 'issue_not_found' };
    }

    if (!payload.success) {
      logger.warn({ patchTaskId: payload.patchTaskId }, 'Codex patch failed');
      this.issueQueue.updateStatus(payload.issueId, 'open');
      await this.bot.sendMessage(
        this.alertChatId,
        `❌ Codex patch failed for \`${payload.issueId}\`:\n${payload.error ?? 'unknown error'}`,
      );
      return { status: 'patch_failed' };
    }

    // Claude Code reviews the patch
    const review = await this.decisionEngine.reviewPatch(
      issue.decision?.summary ?? issue.observability.recentLogs.slice(-5).join('\n'),
      payload.patchDiff,
    );

    this.issueQueue.updateStatus(payload.issueId, 'review_requested', {
      patchPrUrl: payload.prUrl,
    });

    // Send review result to Telegram with approve/reject buttons
    const lines: string[] = [];
    lines.push(review.approved ? '✅ *Patch Ready for Merge*' : '⚠️ *Patch Needs Revision*');
    lines.push('');
    if (payload.prUrl) lines.push(`PR: ${payload.prUrl}`);
    lines.push('');
    lines.push('*Claude Code review:*');
    lines.push(payload.explanation.slice(0, 400));
    if (review.comments) {
      lines.push('');
      lines.push(`_${review.comments.slice(0, 400)}_`);
    }

    const replyMarkup: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: '✅ Approve & Merge', callback_data: `approve_patch:${payload.issueId}` },
        { text: '❌ Reject',          callback_data: `reject_patch:${payload.issueId}` },
      ]],
    };

    await this.bot.sendMessage(this.alertChatId, lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      reply_markup: replyMarkup,
    });

    return { status: review.approved ? 'review_passed' : 'review_concerns' };
  }

  async handleDecision(payload: PatchDecisionPayload): Promise<{ status: string }> {
    const issue = this.issueQueue.getById(payload.issueId);
    if (!issue) return { status: 'issue_not_found' };

    if (payload.approved) {
      this.issueQueue.updateStatus(payload.issueId, 'approved');
      if (issue.patchPrUrl) {
        await this.n8nClient.triggerMergeFlow(
          payload.issueId,
          issue.patchPrUrl,
          0,
        );
      }
      logger.info({ issueId: payload.issueId, by: payload.approvedBy }, 'Patch approved — merge triggered');
      return { status: 'merge_triggered' };
    }

    // Rejected — re-open for another round
    this.issueQueue.updateStatus(payload.issueId, 'open');
    await this.n8nClient.notifyPatchRejected(payload.issueId, 0);
    logger.info({ issueId: payload.issueId }, 'Patch rejected — issue re-opened');
    return { status: 'rejected' };
  }
}
