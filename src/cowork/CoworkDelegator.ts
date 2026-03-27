/**
 * CoworkDelegator
 *
 * Control Tower가 혼자 처리할 수 없는 작업을 Claude Cowork에 자동 위임.
 *
 * 위임 조건:
 *  - DecisionEngine이 'escalate' 또는 'request_human_review' 결정 시
 *  - 3회 이상 패치 실패
 *  - 아키텍처 변경이 필요한 복잡도 판단 시
 *  - 비용 한도 초과로 모든 에이전트가 불가능할 때
 *
 * 위임 방법:
 *  1. GitHub Issue 자동 생성 (라벨: cowork-needed)
 *  2. Telegram 알림 (링크 포함)
 *  3. 작업 컨텍스트 전체를 이슈 본문에 첨부
 */

import type { Issue, IssueDecision } from '../types/issue.js';
import { logger } from '../utils/logger.js';

export type DelegationReason =
  | 'escalate'
  | 'patch_retry_exceeded'
  | 'architecture_change'
  | 'all_agents_over_budget'
  | 'decision_engine_error';

export interface DelegationRequest {
  reason: DelegationReason;
  issue?: Issue;
  decision?: IssueDecision;
  context: string;        // 전달할 컨텍스트 전문
  urgency: 'immediate' | 'normal';
}

export interface DelegationResult {
  githubIssueUrl?: string;
  telegramSent: boolean;
  delegatedAt: string;
}

export class CoworkDelegator {
  private githubToken  = process.env.GITHUB_TOKEN ?? '';
  private githubOwner  = process.env.GITHUB_OWNER ?? '';
  private githubRepo   = process.env.GITHUB_REPO ?? '';
  private botToken     = process.env.TELEGRAM_BOT_TOKEN ?? '';
  private alertChatId  = process.env.TELEGRAM_ALERT_CHAT_ID ?? '';

  async delegate(req: DelegationRequest): Promise<DelegationResult> {
    logger.info({ reason: req.reason, urgency: req.urgency }, 'Delegating to Cowork');

    const [issueUrl, telegramSent] = await Promise.all([
      this.createGithubIssue(req),
      this.notifyTelegram(req),
    ]);

    return {
      githubIssueUrl: issueUrl ?? undefined,
      telegramSent,
      delegatedAt: new Date().toISOString(),
    };
  }

  /**
   * GitHub Issue 생성 — 라벨 'cowork-needed' 부착
   * Claude Code / Cowork가 이슈를 보고 처리
   */
  private async createGithubIssue(req: DelegationRequest): Promise<string | null> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      logger.warn('CoworkDelegator: GitHub env not configured, skipping issue creation');
      return null;
    }

    const title = this.buildTitle(req);
    const body  = this.buildIssueBody(req);

    try {
      const res = await fetch(
        `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/issues`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.githubToken}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            title,
            body,
            labels: ['cowork-needed', req.urgency === 'immediate' ? 'urgent' : 'normal'],
          }),
        },
      );

      if (!res.ok) {
        logger.error({ status: res.status }, 'GitHub issue creation failed');
        return null;
      }

      const data = await res.json() as { html_url: string };
      logger.info({ url: data.html_url }, 'Cowork GitHub issue created');
      return data.html_url;
    } catch (e) {
      logger.error({ e }, 'GitHub issue creation error');
      return null;
    }
  }

  private async notifyTelegram(req: DelegationRequest): Promise<boolean> {
    if (!this.botToken || !this.alertChatId) return false;

    const urgencyIcon = req.urgency === 'immediate' ? '🚨' : '📋';
    const text = [
      `${urgencyIcon} *Cowork 위임 요청*`,
      ``,
      `사유: \`${req.reason}\``,
      req.issue ? `이슈: \`${req.issue.id}\` (${req.issue.observability.serviceName})` : '',
      ``,
      req.decision?.summary ?? req.context.slice(0, 300),
    ].filter(Boolean).join('\n');

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.alertChatId,
            text,
            parse_mode: 'MarkdownV2',
          }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  private buildTitle(req: DelegationRequest): string {
    const prefix = req.urgency === 'immediate' ? '[URGENT]' : '[Cowork]';
    if (req.issue) {
      return `${prefix} ${req.reason}: ${req.issue.observability.serviceName} (${req.issue.id.slice(0, 8)})`;
    }
    return `${prefix} ${req.reason}`;
  }

  private buildIssueBody(req: DelegationRequest): string {
    const sections: string[] = [
      `## Control Tower 위임 요청`,
      ``,
      `- **사유**: ${req.reason}`,
      `- **긴급도**: ${req.urgency}`,
      `- **위임 시각**: ${new Date().toISOString()}`,
      ``,
    ];

    if (req.issue) {
      const obs = req.issue.observability;
      sections.push(
        `## 이슈 정보`,
        `- **서비스**: ${obs.serviceName}`,
        `- **심각도**: ${obs.severity}`,
        `- **Fingerprint**: \`${obs.fingerprint}\``,
        `- **발생 횟수**: ${obs.occurrenceCount}`,
        `- **커밋**: \`${obs.commitHash ?? 'unknown'}\``,
        `- **배포 버전**: ${obs.deployVersion ?? 'unknown'}`,
        ``,
        `## 최근 로그`,
        `\`\`\``,
        obs.recentLogs.slice(-20).join('\n'),
        `\`\`\``,
        ``,
      );
    }

    if (req.decision) {
      sections.push(
        `## Control Tower 분석`,
        req.decision.summary,
        ``,
        `**추천 조치**: ${req.decision.recommendedAction}`,
        ``,
      );
    }

    sections.push(
      `## 추가 컨텍스트`,
      req.context,
      ``,
      `---`,
      `_Control Tower가 자동 생성한 이슈입니다. \`cowork-needed\` 라벨이 부착되어 있습니다._`,
    );

    return sections.join('\n');
  }
}
