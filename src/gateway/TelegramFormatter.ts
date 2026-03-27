import type { OrchestratedResult, TaskResult } from '../types/task.js';
import type { Issue } from '../types/issue.js';

/** Escape special characters for Telegram MarkdownV2. */
function esc(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

const SEVERITY_ICON: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

export class TelegramFormatter {
  /**
   * Format an orchestrated result into a Telegram MarkdownV2 message.
   * For parallel-compare mode, shows a comparison table + the winner.
   */
  format(result: OrchestratedResult): string {
    if (result.executionMode === 'single-best') {
      return this.formatSingleBest(result);
    }
    return this.formatParallelCompare(result);
  }

  private formatSingleBest(result: OrchestratedResult): string {
    const { winner, totalCostUsd, totalLatencyMs } = result;
    const meta = `_${esc(winner.agentId)} · ${esc((totalCostUsd * 100).toFixed(3))}¢ · ${esc((totalLatencyMs / 1000).toFixed(1))}s_`;
    return `${meta}\n\n${esc(winner.content)}`;
  }

  private formatParallelCompare(result: OrchestratedResult): string {
    const lines: string[] = [];

    // Header
    lines.push(`*🏆 Winner: ${esc(result.winner.agentId)}*`);
    lines.push(`_Mode: ${esc(result.executionMode)} · Total cost: ${esc((result.totalCostUsd * 100).toFixed(3))}¢ · ${esc((result.totalLatencyMs / 1000).toFixed(1))}s_`);
    lines.push('');

    // Comparison table
    lines.push('*Agent Results:*');
    const successful = result.allResults.filter((r) => r.status === 'completed');
    for (const r of successful) {
      const isWinner = r.agentId === result.winner.agentId;
      const prefix = isWinner ? '✅' : '  ';
      const tokens = `${r.inputTokens}→${r.outputTokens}tok`;
      const latency = `${(r.latencyMs / 1000).toFixed(1)}s`;
      lines.push(`${prefix} \`${esc(r.agentId)}\` ${esc(tokens)} ${esc(latency)}`);
    }

    const failed = result.allResults.filter((r) => r.status === 'failed');
    for (const r of failed) {
      lines.push(`❌ \`${esc(r.agentId)}\` ${esc(r.error ?? 'unknown error')}`);
    }

    lines.push('');
    lines.push('*Best Response:*');
    lines.push(esc(result.winner.content));

    return lines.join('\n');
  }

  /** Short status message to send while the task is running. */
  formatProcessing(agentCount: number, mode: string): string {
    return `⚙️ _Processing\\.\\.\\. running ${esc(String(agentCount))} agent${agentCount !== 1 ? 's' : ''} in ${esc(mode)} mode_`;
  }

  /** Format an error into a user-friendly Telegram message. */
  formatError(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return `❌ *Error:* ${esc(msg)}`;
  }

  /**
   * Format a standardised issue alert notification.
   * Includes all observability fields + action buttons (via inline keyboard JSON).
   */
  formatIssueAlert(issue: Issue): { text: string; replyMarkup: object } {
    const obs = issue.observability;
    const icon = SEVERITY_ICON[obs.severity] ?? '⚪';
    const lines: string[] = [];

    lines.push(`${icon} *\\[${esc(obs.severity.toUpperCase())}\\] ${esc(obs.serviceName)}*`);
    lines.push(`Fingerprint: \`${esc(obs.fingerprint)}\``);
    lines.push(`First seen: ${esc(obs.firstSeenAt.replace('T', ' ').slice(0, 19))} UTC`);
    lines.push(`Occurrences: *${esc(String(obs.occurrenceCount))}*`);

    if (obs.deployVersion) lines.push(`Deploy: \`${esc(obs.deployVersion)}\``);
    if (obs.commitHash) lines.push(`Commit: \`${esc(obs.commitHash.slice(0, 8))}\``);
    if (obs.reproduceCommand) {
      lines.push(`Reproduce: \`${esc(obs.reproduceCommand)}\``);
    }

    if (obs.recentLogs.length > 0) {
      lines.push('');
      lines.push('*Recent logs:*');
      const logPreview = obs.recentLogs.slice(-5).join('\n');
      lines.push(`\`\`\`\n${esc(logPreview.slice(0, 800))}\n\`\`\``);
    }

    if (issue.decision) {
      lines.push('');
      lines.push('*Control Tower decision:*');
      lines.push(esc(issue.decision.summary));
      lines.push(`→ ${esc(issue.decision.recommendedAction)}`);
      lines.push(`Assigned to: \`${esc(issue.decision.assignTo)}\``);
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🔧 Request Codex Patch', callback_data: `codex_patch:${issue.id}` },
          { text: '👀 Request Cowork Review', callback_data: `cowork_review:${issue.id}` },
        ],
        [
          { text: '✅ Close Issue', callback_data: `close_issue:${issue.id}` },
        ],
      ],
    };

    return { text: lines.join('\n'), replyMarkup };
  }

  /**
   * Split a long message into chunks that fit within Telegram's 4096 char limit.
   */
  splitMessage(text: string, maxLen = 4000): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
    }
    return chunks;
  }
}
