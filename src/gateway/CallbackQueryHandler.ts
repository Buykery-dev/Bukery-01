import TelegramBot from 'node-telegram-bot-api';
import type { IssueQueue } from '../queue/IssueQueue.js';
import type { DecisionEngine } from '../core/DecisionEngine.js';
import type { PatchFlow } from '../flows/PatchFlow.js';
import { CoworkDelegator } from '../cowork/CoworkDelegator.js';
import { logger } from '../utils/logger.js';

export class CallbackQueryHandler {
  constructor(
    private bot: TelegramBot,
    private issueQueue: IssueQueue,
    private decisionEngine: DecisionEngine,
    private patchFlow: PatchFlow,
  ) {}

  register(): void {
    this.bot.on('callback_query', async (query) => {
      if (!query.data) return;
      const colonIdx = query.data.indexOf(':');
      if (colonIdx === -1) return;

      const action  = query.data.slice(0, colonIdx);
      const issueId = query.data.slice(colonIdx + 1);
      const chatId  = query.message?.chat.id;

      try {
        await this.dispatch(action, issueId, chatId, query);
        await this.bot.answerCallbackQuery(query.id);
      } catch (err) {
        logger.error({ err, action, issueId }, 'Callback query error');
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Error — check logs', show_alert: true,
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
        await this.patchFlow.handleDecision({
          issueId, approved: true, approvedBy: query.from.username,
        });
        if (chatId) await this.bot.sendMessage(chatId,
          `✅ 머지 완료 \\(@${query.from.username ?? query.from.id}\\)`,
          { parse_mode: 'MarkdownV2' });
        break;
      case 'reject_patch':
        await this.patchFlow.handleDecision({ issueId, approved: false });
        if (chatId) await this.bot.sendMessage(chatId, `패치 거절 — 이슈 재오픈됨`);
        break;
      case 'close_issue':
        this.issueQueue.updateStatus(issueId, 'closed');
        if (chatId) await this.bot.sendMessage(chatId, `Issue \`${issueId}\` closed\\.`,
          { parse_mode: 'MarkdownV2' });
        break;
      default:
        logger.warn({ action }, 'Unknown callback action');
    }
  }

  private async handleCodexPatch(
    issueId: string,
    chatId: number | undefined,
    query: TelegramBot.CallbackQuery,
  ): Promise<void> {
    const issue = this.issueQueue.getById(issueId);
    if (!issue || !chatId) return;

    const decision = await this.decisionEngine.analyseIssue(issue);

    if (!['codex', 'claude-code'].includes(decision.assignTo)) {
      await this.bot.sendMessage(chatId,
        `Claude Code 판단: ${decision.recommendedAction}\n→ Codex 미적합: ${decision.summary}`);
      return;
    }

    // PatchFlow가 Codex 직접 호출 + GitHub PR + Telegram 알림 처리
    await this.bot.sendMessage(chatId, `⚙️ Codex 패치 생성 중\\.\\.\\.`, { parse_mode: 'MarkdownV2' });
    this.patchFlow.requestPatch(issueId).catch((e) =>
      logger.error({ e, issueId }, 'requestPatch error'));

    logger.info({ issueId, by: query.from.username }, 'Codex patch requested');
  }

  private async handleCoworkReview(issueId: string, chatId: number | undefined): Promise<void> {
    const issue = this.issueQueue.getById(issueId);
    if (!issue || !chatId) return;

    const delegator = new CoworkDelegator();
    const result = await delegator.delegate({
      reason:   'escalate',
      issue,
      decision: issue.decision,
      context:  issue.observability.recentLogs.slice(-10).join('\n'),
      urgency:  'normal',
    });

    const msg = result.githubIssueUrl
      ? `👀 Cowork 리뷰 요청 완료\\. Issue: ${result.githubIssueUrl}`
      : `👀 Cowork 알림 전송 완료 \\(GitHub 미설정\\)`;

    await this.bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  }
}
