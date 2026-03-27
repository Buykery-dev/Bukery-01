import type { CodexPatchCompletePayload, PatchDecisionPayload } from '../types/webhook.js';
import { IssueQueue } from '../queue/IssueQueue.js';
import { DecisionEngine } from '../core/DecisionEngine.js';
import { TelegramFormatter } from '../gateway/TelegramFormatter.js';
import { GitHubClient } from '../github/GitHubClient.js';
import { CodexAgent } from '../agents/CodexAgent.js';
import { logger } from '../utils/logger.js';
import TelegramBot from 'node-telegram-bot-api';

/**
 * PatchFlow — n8n 없이 직접 처리
 *
 * 1. requestPatch()   : Codex 직접 호출 → GitHubClient PR 생성 → Claude Code 리뷰 → Telegram
 * 2. handleDecision() : 승인 → GitHub 머지 / 거절 → 재오픈
 */
export class PatchFlow {
  private codex = new CodexAgent();
  private github = new GitHubClient();

  constructor(
    private issueQueue: IssueQueue,
    private decisionEngine: DecisionEngine,
    private formatter: TelegramFormatter,
    private bot: TelegramBot,
    private alertChatId: number,
  ) {}

  /**
   * 이슈 ID를 받아 Codex 패치 생성 → PR → Telegram 알림
   */
  async requestPatch(issueId: string): Promise<void> {
    const issue = this.issueQueue.getById(issueId);
    if (!issue) { logger.warn({ issueId }, 'PatchFlow.requestPatch: issue not found'); return; }

    this.issueQueue.updateStatus(issueId, 'patch_requested');

    const obs = issue.observability;
    const prompt = [
      `You are Codex, a patch executor. Generate a minimal targeted fix.`,
      ``,
      `Service: ${obs.serviceName}`,
      `Error: ${obs.recentLogs.slice(-3).join(' | ')}`,
      `Stack: ${obs.stackTrace ?? 'none'}`,
      `Commit: ${obs.commitHash ?? 'unknown'}`,
      ``,
      `Instructions from Control Tower:`,
      issue.decision?.suggestedPrompt ?? issue.decision?.recommendedAction ?? 'Fix the error.',
      ``,
      `Output JSON only:`,
      `{ "files": [{ "path": "...", "content": "..." }], "explanation": "..." }`,
    ].join('\n');

    let patchResult: { files: Array<{ path: string; content: string }>; explanation: string };

    try {
      const task = {
        id:            issueId,
        prompt,
        type:          'code' as const,
        executionMode: 'single-best' as const,
        createdAt:     new Date(),
      };
      const result = await this.codex.execute(task);
      if (result.status !== 'completed') throw new Error(result.error ?? 'Codex failed');

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Codex returned no JSON');
      patchResult = JSON.parse(jsonMatch[0]);
    } catch (err) {
      logger.error({ err, issueId }, 'Codex patch generation failed');
      this.issueQueue.updateStatus(issueId, 'open');
      await this.bot.sendMessage(this.alertChatId,
        `❌ Codex 패치 실패 \\(issue \`${issueId}\`\\): ${err instanceof Error ? err.message : String(err)}`,
        { parse_mode: 'MarkdownV2' });
      return;
    }

    // Claude Code 리뷰
    const review = await this.decisionEngine.reviewPatch(
      issue.decision?.summary ?? obs.recentLogs.slice(-5).join('\n'),
      patchResult.explanation,
    );

    // GitHub PR 생성 (설정된 경우)
    let prUrl: string | undefined;
    if (this.github.isConfigured()) {
      try {
        const pr = await this.github.submitPatch({
          issueId,
          fingerprint: obs.fingerprint,
          patchFiles:  patchResult.files,
          prTitle:     `fix: auto-patch for ${obs.serviceName} (${obs.fingerprint.slice(0, 8)})`,
          prBody:      [
            `## Auto-patch by Codex`,
            `**Issue**: ${issueId}`,
            `**Fingerprint**: \`${obs.fingerprint}\``,
            ``,
            `### Explanation`,
            patchResult.explanation,
            ``,
            `### Claude Code Review`,
            review.comments,
          ].join('\n'),
        });
        prUrl = pr.prUrl;
        this.issueQueue.updateStatus(issueId, 'review_requested', { patchPrUrl: prUrl });
      } catch (err) {
        logger.error({ err }, 'GitHub PR creation failed');
      }
    } else {
      this.issueQueue.updateStatus(issueId, 'review_requested');
    }

    // Telegram: 리뷰 결과 + 승인/거절 버튼
    const lines = [
      review.approved ? '✅ *패치 리뷰 통과*' : '⚠️ *패치 수정 필요*',
      prUrl ? `PR: ${prUrl}` : '',
      '',
      '*Claude Code 리뷰:*',
      review.comments.slice(0, 400),
    ].filter(Boolean);

    await this.bot.sendMessage(this.alertChatId, lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve & Merge', callback_data: `approve_patch:${issueId}` },
          { text: '❌ Reject',          callback_data: `reject_patch:${issueId}` },
        ]],
      } as TelegramBot.InlineKeyboardMarkup,
    });
  }

  /**
   * 웹훅으로 외부에서 패치 완료 통보 받을 때 (선택적)
   */
  async handlePatchComplete(payload: CodexPatchCompletePayload): Promise<{ status: string }> {
    const issue = this.issueQueue.getById(payload.issueId);
    if (!issue) return { status: 'issue_not_found' };

    if (!payload.success) {
      this.issueQueue.updateStatus(payload.issueId, 'open');
      return { status: 'patch_failed' };
    }

    const review = await this.decisionEngine.reviewPatch(
      issue.decision?.summary ?? '',
      payload.patchDiff,
    );

    this.issueQueue.updateStatus(payload.issueId, 'review_requested', { patchPrUrl: payload.prUrl });

    await this.bot.sendMessage(this.alertChatId,
      `${review.approved ? '✅' : '⚠️'} Patch ready for \`${payload.issueId}\`\n${review.comments.slice(0, 300)}`, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_patch:${payload.issueId}` },
            { text: '❌ Reject',  callback_data: `reject_patch:${payload.issueId}` },
          ]],
        } as TelegramBot.InlineKeyboardMarkup,
      });

    return { status: 'notified' };
  }

  /**
   * Telegram 버튼 → 승인(머지) 또는 거절
   */
  async handleDecision(payload: PatchDecisionPayload): Promise<{ status: string }> {
    const issue = this.issueQueue.getById(payload.issueId);
    if (!issue) return { status: 'issue_not_found' };

    if (payload.approved) {
      // GitHub 머지
      if (this.github.isConfigured() && issue.patchPrUrl) {
        const prNumberMatch = issue.patchPrUrl.match(/\/pull\/(\d+)/);
        if (prNumberMatch) {
          await this.github.mergePR(
            Number(prNumberMatch[1]),
            `fix: auto-patch ${issue.observability.fingerprint.slice(0, 8)}`,
          );
        }
      }
      this.issueQueue.updateStatus(payload.issueId, 'approved');
      logger.info({ issueId: payload.issueId, by: payload.approvedBy }, 'Patch approved and merged');
      return { status: 'merged' };
    }

    this.issueQueue.updateStatus(payload.issueId, 'open');
    logger.info({ issueId: payload.issueId }, 'Patch rejected — re-opened');
    return { status: 'rejected' };
  }
}
