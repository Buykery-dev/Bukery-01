import type { AgentId } from './agent.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type IssueStatus =
  | 'open'
  | 'analyzing'
  | 'patch_requested'
  | 'patch_ready'
  | 'review_requested'
  | 'approved'
  | 'deployed'
  | 'closed';

export interface IssueObservability {
  serviceName: string;
  severity: Severity;
  firstSeenAt: string;       // ISO 8601
  lastSeenAt: string;        // ISO 8601
  occurrenceCount: number;
  fingerprint: string;       // sha256 of normalised error signature
  commitHash?: string;
  deployVersion?: string;
  recentLogs: string[];      // last N log lines
  reproduceCommand?: string;
  stackTrace?: string;
}

export interface IssueDecision {
  summary: string;           // Claude Code's analysis
  recommendedAction: string;
  assignTo: AgentId;         // which agent should handle this
  priority: number;          // 1 (highest) – 5 (lowest)
  requiresHumanApproval: boolean;
  suggestedPrompt?: string;  // the prompt to send to the assigned agent
}

export interface Issue {
  id: string;
  observability: IssueObservability;
  decision?: IssueDecision;
  status: IssueStatus;
  patchPrUrl?: string;
  createdAt: string;
  updatedAt: string;
  telegramChatId?: number;
  telegramAlertMessageId?: number;
}
