import type { Issue } from '../types/issue.js';
import type { IssueDecision } from '../types/issue.js';
import { logger } from '../utils/logger.js';

/**
 * N8nClient — outbound triggers FROM Control Tower TO n8n webhook flows.
 *
 * Each method sends a POST to the corresponding n8n webhook URL
 * (set via environment variables).  n8n then orchestrates the downstream
 * steps (Codex API call, GitHub PR creation, merge, etc.).
 */
export class N8nClient {
  private readonly webhooks = {
    codexPatch:      process.env.N8N_WEBHOOK_CODEX_PATCH ?? '',
    reviewRequest:   process.env.N8N_WEBHOOK_REVIEW_REQUEST ?? '',
    mergeApproval:   process.env.N8N_WEBHOOK_MERGE_APPROVAL ?? '',
    patchRejected:   process.env.N8N_WEBHOOK_PATCH_REJECTED ?? '',
  };

  /** Trigger the n8n Codex Patch Flow for an issue. */
  async triggerPatchFlow(issue: Issue, decision: IssueDecision): Promise<void> {
    await this.post(this.webhooks.codexPatch, {
      issueId: issue.id,
      fingerprintId: issue.observability.fingerprint,
      serviceName: issue.observability.serviceName,
      severity: issue.observability.severity,
      errorMessage: issue.observability.recentLogs.at(-1) ?? '',
      stackTrace: issue.observability.stackTrace,
      commitHash: issue.observability.commitHash,
      deployVersion: issue.observability.deployVersion,
      suggestedApproach: decision.suggestedPrompt ?? decision.recommendedAction,
    });
  }

  /** Trigger a Cowork review request flow. */
  async triggerReviewFlow(issue: Issue): Promise<void> {
    await this.post(this.webhooks.reviewRequest, {
      issueId: issue.id,
      serviceName: issue.observability.serviceName,
      severity: issue.observability.severity,
      fingerprint: issue.observability.fingerprint,
      logs: issue.observability.recentLogs.slice(-20).join('\n'),
    });
  }

  /** Trigger the merge approval flow after human clicks approve in Telegram. */
  async triggerMergeFlow(issueId: string, patchPrUrl: string, approvedByUserId: number): Promise<void> {
    await this.post(this.webhooks.mergeApproval, {
      issueId,
      patchPrUrl,
      approvedByUserId,
    });
  }

  /** Notify n8n that a patch was rejected by the human. */
  async notifyPatchRejected(issueId: string, rejectedByUserId: number): Promise<void> {
    await this.post(this.webhooks.patchRejected, {
      issueId,
      rejectedByUserId,
    });
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    if (!url) {
      logger.warn({ body }, 'N8nClient: webhook URL not configured, skipping');
      return null;
    }

    logger.info({ url }, 'Triggering n8n webhook');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': process.env.WEBHOOK_SECRET ?? '',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`n8n webhook failed ${response.status}: ${text}`);
    }

    return response.json().catch(() => null);
  }
}
