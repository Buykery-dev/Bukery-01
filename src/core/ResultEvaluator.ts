import type { TaskResult } from '../types/task.js';
import type { AgentScore, EvaluationWeights } from '../types/evaluation.js';

const DEFAULT_WEIGHTS: EvaluationWeights = {
  completeness: 0.4,
  clarity: 0.3,
  length: 0.15,
  latency: 0.15,
};

export class ResultEvaluator {
  private weights: EvaluationWeights;

  constructor(weights: EvaluationWeights = DEFAULT_WEIGHTS) {
    this.weights = weights;
  }

  /**
   * Score all successful results and return them sorted best → worst.
   * Failed results are excluded from ranking.
   */
  rank(results: TaskResult[]): AgentScore[] {
    const successful = results.filter((r) => r.status === 'completed' && r.content);
    if (successful.length === 0) return [];

    const maxLatency = Math.max(...successful.map((r) => r.latencyMs));
    const lengths = successful.map((r) => r.content.length);
    const medianLen = this.median(lengths);

    const scored: AgentScore[] = successful.map((result) => {
      const completeness = this.scoreCompleteness(result.content);
      const clarity = this.scoreClarity(result.content);
      const length = this.scoreLength(result.content.length, medianLen);
      const latency = maxLatency > 0 ? 1 - result.latencyMs / maxLatency : 1;

      const total =
        completeness * this.weights.completeness +
        clarity * this.weights.clarity +
        length * this.weights.length +
        latency * this.weights.latency;

      return {
        agentId: result.agentId,
        criteria: { completeness, clarity, length, latency },
        total,
      };
    });

    return scored.sort((a, b) => b.total - a.total);
  }

  pickWinner(results: TaskResult[]): TaskResult | null {
    const ranked = this.rank(results);
    if (ranked.length === 0) return null;
    const winnerId = ranked[0]!.agentId;
    return results.find((r) => r.agentId === winnerId) ?? null;
  }

  // Heuristic: penalises very short answers, rewards structured responses
  private scoreCompleteness(content: string): number {
    if (content.length < 50) return 0.1;
    if (content.length < 200) return 0.5;

    // Bonus for structured content (headers, code blocks, lists)
    let bonus = 0;
    if (/^#{1,3} /m.test(content)) bonus += 0.1;     // markdown headers
    if (/```/.test(content)) bonus += 0.1;             // code blocks
    if (/^[-*] /m.test(content)) bonus += 0.05;        // bullet lists
    if (/^\d+\. /m.test(content)) bonus += 0.05;       // numbered lists

    return Math.min(0.8 + bonus, 1.0);
  }

  // Heuristic: readable sentences, not just noise
  private scoreClarity(content: string): number {
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length === 0) return 0.2;
    const avgLen = content.length / Math.max(sentences.length, 1);
    // Ideal sentence length: 50-150 chars
    if (avgLen >= 50 && avgLen <= 150) return 1.0;
    if (avgLen < 30 || avgLen > 300) return 0.5;
    return 0.75;
  }

  // Penalise very short or very long outliers
  private scoreLength(len: number, medianLen: number): number {
    if (medianLen === 0) return 0.5;
    const ratio = len / medianLen;
    if (ratio < 0.2 || ratio > 5) return 0.1;
    if (ratio < 0.5 || ratio > 3) return 0.5;
    return 1.0;
  }

  private median(nums: number[]): number {
    if (nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
}
