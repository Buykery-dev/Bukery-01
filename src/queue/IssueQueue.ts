import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type { Issue, IssueObservability, IssueStatus } from '../types/issue.js';
import { logger } from '../utils/logger.js';

interface CooldownEntry {
  fingerprint: string;
  lastAlertAt: number;      // epoch ms
  alertCount: number;
}

export class IssueQueue {
  private issues: Map<string, Issue> = new Map();
  private cooldowns: Map<string, CooldownEntry> = new Map();
  private persistPath: string;

  /** Minimum ms between Telegram alerts for the same fingerprint. */
  private readonly COOLDOWN_MS = 5 * 60 * 1000;    // 5 minutes
  /** Maximum retries per issue before it's auto-closed as unresolvable. */
  private readonly MAX_RETRIES = 3;

  constructor(persistPath = './issue-queue.json') {
    this.persistPath = persistPath;
    this.load();
  }

  /**
   * Add or update an issue from an OpenClo alert.
   * Returns:
   *   - the issue object if it's new or should re-alert
   *   - null if it's a duplicate within the cooldown window
   */
  upsert(obs: IssueObservability): Issue | null {
    const existing = this.findByFingerprint(obs.fingerprint);

    if (existing) {
      // Update occurrence count and last seen
      existing.observability.occurrenceCount += obs.occurrenceCount;
      existing.observability.lastSeenAt = obs.lastSeenAt;
      if (obs.recentLogs.length > 0) {
        existing.observability.recentLogs = obs.recentLogs;
      }
      existing.updatedAt = new Date().toISOString();
      this.persist();

      // Check cooldown — don't re-alert if too recent
      if (this.isInCooldown(obs.fingerprint)) {
        logger.debug({ fingerprint: obs.fingerprint }, 'Issue in cooldown — suppressing alert');
        return null;
      }

      this.refreshCooldown(obs.fingerprint);
      return existing;
    }

    // New issue
    const issue: Issue = {
      id: uuidv4(),
      observability: obs,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.issues.set(issue.id, issue);
    this.refreshCooldown(obs.fingerprint);
    this.persist();

    logger.info({ issueId: issue.id, fingerprint: obs.fingerprint }, 'New issue created');
    return issue;
  }

  updateStatus(issueId: string, status: IssueStatus, extra?: Partial<Issue>): void {
    const issue = this.issues.get(issueId);
    if (!issue) return;
    issue.status = status;
    issue.updatedAt = new Date().toISOString();
    if (extra) Object.assign(issue, extra);
    this.persist();
  }

  getById(id: string): Issue | undefined {
    return this.issues.get(id);
  }

  getOpen(): Issue[] {
    return [...this.issues.values()].filter(
      (i) => i.status === 'open' || i.status === 'analyzing',
    );
  }

  private findByFingerprint(fp: string): Issue | undefined {
    return [...this.issues.values()].find(
      (i) => i.observability.fingerprint === fp && i.status !== 'closed',
    );
  }

  private isInCooldown(fp: string): boolean {
    const entry = this.cooldowns.get(fp);
    if (!entry) return false;
    return Date.now() - entry.lastAlertAt < this.COOLDOWN_MS;
  }

  private refreshCooldown(fp: string): void {
    const existing = this.cooldowns.get(fp);
    this.cooldowns.set(fp, {
      fingerprint: fp,
      lastAlertAt: Date.now(),
      alertCount: (existing?.alertCount ?? 0) + 1,
    });
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as Issue[];
        for (const issue of raw) {
          this.issues.set(issue.id, issue);
        }
      }
    } catch {
      this.issues = new Map();
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify([...this.issues.values()], null, 2),
      );
    } catch {
      // best effort
    }
  }
}
