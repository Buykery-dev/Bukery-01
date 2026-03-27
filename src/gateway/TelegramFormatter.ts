import type { OrchestratedResult, TaskResult } from '../types/task.js';

/** Escape special characters for Telegram MarkdownV2. */
function esc(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

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
