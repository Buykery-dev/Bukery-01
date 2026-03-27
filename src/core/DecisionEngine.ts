import Anthropic from '@anthropic-ai/sdk';
import type { Issue, IssueDecision } from '../types/issue.js';
import type { AgentId } from '../types/agent.js';
import { logger } from '../utils/logger.js';

/**
 * DecisionEngine — Claude Code as the Control Tower brain.
 *
 * Responsibilities:
 *  1. Analyse an incoming issue and produce a structured decision
 *  2. Decide which agent should handle the issue and at what priority
 *  3. Generate a targeted prompt for the assigned agent
 *
 * Only Claude Code (claude-sonnet-4-6 + tools) is used here.
 * No other model makes orchestration decisions.
 */
export class DecisionEngine {
  private client: Anthropic;
  private model = 'claude-sonnet-4-6';

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async analyseIssue(issue: Issue): Promise<IssueDecision> {
    const obs = issue.observability;

    const prompt = `You are the Control Tower decision engine for the Bukery platform.
Analyse the following production issue and return a JSON decision object.

## Issue Details
- Service: ${obs.serviceName}
- Severity: ${obs.severity}
- Fingerprint: ${obs.fingerprint}
- First seen: ${obs.firstSeenAt}
- Occurrence count: ${obs.occurrenceCount}
- Deploy version: ${obs.deployVersion ?? 'unknown'}
- Commit: ${obs.commitHash ?? 'unknown'}
${obs.reproduceCommand ? `- Reproduce: \`${obs.reproduceCommand}\`` : ''}

## Recent Logs
\`\`\`
${obs.recentLogs.slice(-20).join('\n')}
\`\`\`

${obs.stackTrace ? `## Stack Trace\n\`\`\`\n${obs.stackTrace}\n\`\`\`` : ''}

## Your Task
Return a valid JSON object with EXACTLY these fields:
{
  "summary": "1-2 sentence plain-English analysis",
  "recommendedAction": "clear action description",
  "assignTo": one of "codex" | "claude-code" | "gpt" | "claude",
  "priority": integer 1-5 (1=critical, 5=low),
  "requiresHumanApproval": boolean,
  "suggestedPrompt": "exact prompt to send to the assigned agent (optional)"
}

Assignment rules:
- "codex": small focused bug fix, test addition, or refactor (< 50 lines)
- "claude-code": complex multi-file change, architectural decision, security issue
- "claude" or "gpt": investigation only, no code change needed
- requiresHumanApproval = true if the fix touches auth, payments, data migrations, or is severity critical/high

Respond with ONLY the JSON object, no markdown, no explanation.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: 'You are a precise JSON-outputting decision engine. Output only valid JSON.',
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');

      const decision = JSON.parse(text) as IssueDecision;
      logger.info(
        { issueId: issue.id, assignTo: decision.assignTo, priority: decision.priority },
        'Decision engine produced decision',
      );
      return decision;
    } catch (err) {
      logger.error({ err, issueId: issue.id }, 'Decision engine failed — using safe default');
      return {
        summary: 'Decision engine error — defaulting to human review.',
        recommendedAction: 'Manually review issue and assign.',
        assignTo: 'claude' as AgentId,
        priority: 2,
        requiresHumanApproval: true,
      };
    }
  }

  /**
   * Ask Claude Code to review a Codex-generated patch before it goes to PR.
   * Returns { approved: boolean, comments: string }.
   */
  async reviewPatch(
    issueDescription: string,
    patchDiff: string,
  ): Promise<{ approved: boolean; comments: string }> {
    const prompt = `You are a senior code reviewer. Review this patch for correctness, safety, and adherence to the issue requirements.

## Issue
${issueDescription}

## Patch Diff
\`\`\`diff
${patchDiff}
\`\`\`

Return JSON: { "approved": boolean, "comments": "review notes" }
- approved=true only if the patch is correct, safe, and ready to merge
- approved=false if there are bugs, security concerns, or the patch doesn't address the issue
Output ONLY valid JSON.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        system: 'You are a precise JSON-outputting code reviewer.',
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');

      return JSON.parse(text) as { approved: boolean; comments: string };
    } catch {
      return { approved: false, comments: 'Review failed — requires manual inspection.' };
    }
  }
}
