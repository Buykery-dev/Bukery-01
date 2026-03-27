import type { IssueObservability } from '../types/issue.js';
import type { OpenCloAlertPayload } from '../types/webhook.js';
import { fingerprint, classifySeverity } from '../monitor/ErrorFingerprint.js';
import { IssueQueue } from '../queue/IssueQueue.js';
import { DecisionEngine } from '../core/DecisionEngine.js';
import { TelegramFormatter } from '../gateway/TelegramFormatter.js';
import { CoworkDelegator } from '../cowork/CoworkDelegator.js';
import { logger } from '../utils/logger.js';
import TelegramBot from 'node-telegram-bot-api';

/**
 * AlertIngestFlow
 *
 * Pipeline: OpenClo alert → fingerprint → dedup → Claude Code analysis → Telegram
 *
 * Claude Code is the ONLY decision maker here.  This flow never modifies code.
 * It only: analyses, classifies, queues, and notifies.
 */
export class AlertIngestFlow {
  constructor(
    private issueQueue: IssueQueue,
    private decisionEngine: DecisionEngine,
    private formatter: TelegramFormatter,
    private bot: TelegramBot,
    private alertChatId: number,
  ) {}

  async handle(payload: OpenCloAlertPayload): Promise<{ issueId: string | null; status: string }> {
    const fp = fingerprint(payload.errorMessage, payload.stackTrace);
    const severity = payload.severity ?? classifySeverity(payload.errorMessage);

    const obs: IssueObservability = {
      serviceName:      payload.serviceName,
      severity,
      fingerprint:      fp,
      firstSeenAt:      new Date().toISOString(),
      lastSeenAt:       new Date().toISOString(),
      occurrenceCount:  1,
      recentLogs:       payload.recentLogs,
      commitHash:       payload.commitHash,
      deployVersion:    payload.deployVersion,
      reproduceCommand: payload.reproduceCommand,
      stackTrace:       payload.stackTrace,
    };

    // Dedup — returns null if within cooldown window for same fingerprint
    const issue = this.issueQueue.upsert(obs);
    if (!issue) {
      return { issueId: null, status: 'deduped' };
    }

    // Claude Code analyses and decides
    this.issueQueue.updateStatus(issue.id, 'analyzing');
    const decision = await this.decisionEngine.analyseIssue(issue);
    this.issueQueue.updateStatus(issue.id, 'patch_requested', { decision });

    // 자동 위임: escalate 또는 critical + human approval 필요 시 Cowork으로
    if (decision.requiresHumanApproval && obs.severity === 'critical') {
      const delegator = new CoworkDelegator();
      delegator.delegate({
        reason: 'escalate',
        issue: { ...issue, decision },
        decision,
        context: obs.recentLogs.slice(-10).join('\n'),
        urgency: 'immediate',
      }).catch((e) => logger.error({ e }, 'Cowork delegation failed'));
    }

    // Send structured Telegram alert with action buttons
    const { text, replyMarkup } = this.formatter.formatIssueAlert({ ...issue, decision });
    const chunks = this.formatter.splitMessage(text);

    try {
      const lastMsgId = await chunks.reduce<Promise<number>>(async (prevIdP, chunk, i) => {
        const prevId = await prevIdP;
        const sent = await this.bot.sendMessage(this.alertChatId, chunk, {
          parse_mode: 'MarkdownV2',
          ...(i === chunks.length - 1
            ? { reply_markup: replyMarkup as TelegramBot.InlineKeyboardMarkup }
            : {}),
        });
        return sent.message_id;
      }, Promise.resolve(0));

      this.issueQueue.updateStatus(issue.id, 'analyzing', {
        telegramAlertMessageId: lastMsgId,
      });
    } catch (err) {
      logger.error({ err, issueId: issue.id }, 'Failed to send Telegram alert');
    }

    logger.info(
      { issueId: issue.id, assignTo: decision.assignTo, priority: decision.priority },
      'Alert ingested and decided',
    );

    return { issueId: issue.id, status: 'processed' };
  }
}
