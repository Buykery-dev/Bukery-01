import http from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import type { IssueObservability, Severity } from '../types/issue.js';
import { fingerprint, classifySeverity } from '../monitor/ErrorFingerprint.js';
import { IssueQueue } from '../queue/IssueQueue.js';
import { DecisionEngine } from '../core/DecisionEngine.js';
import { logger } from '../utils/logger.js';

/**
 * Payload sent by OpenClo (or any monitor) to POST /webhook/alert
 */
export interface AlertPayload {
  serviceName: string;
  errorMessage: string;
  stackTrace?: string;
  recentLogs?: string[];
  deployVersion?: string;
  commitHash?: string;
  reproduceCommand?: string;
  severity?: Severity;
}

/**
 * Payload sent by n8n to POST /webhook/patch-approved or /webhook/patch-rejected
 */
export interface PatchDecisionPayload {
  issueId: string;
  approved: boolean;
  approvedBy?: string;
}

export interface WebhookServerDeps {
  issueQueue: IssueQueue;
  decisionEngine: DecisionEngine;
  onNewIssue: (obs: IssueObservability) => Promise<void>;
  onPatchDecision: (payload: PatchDecisionPayload) => Promise<void>;
}

export class WebhookServer {
  private server: http.Server;
  private deps: WebhookServerDeps;

  constructor(deps: WebhookServerDeps, port = 3000) {
    this.deps = deps;
    this.server = http.createServer((req, res) => this.dispatch(req, res));
    this.server.listen(port, () => {
      logger.info({ port }, 'n8n webhook server listening');
    });
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method !== 'POST') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    let body: unknown;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    try {
      if (url === '/webhook/alert') {
        await this.handleAlert(body as AlertPayload, res);
      } else if (url === '/webhook/patch-decision') {
        await this.handlePatchDecision(body as PatchDecisionPayload, res);
      } else if (url === '/webhook/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ status: 'ok', ts: new Date().toISOString() }),
        );
      } else {
        res.writeHead(404).end('Not Found');
      }
    } catch (err) {
      logger.error({ err, url }, 'Webhook handler error');
      res.writeHead(500).end('Internal Server Error');
    }
  }

  private async handleAlert(payload: AlertPayload, res: http.ServerResponse): Promise<void> {
    const fp = fingerprint(payload.errorMessage, payload.stackTrace);
    const severity = payload.severity ?? classifySeverity(payload.errorMessage);

    const obs: IssueObservability = {
      serviceName: payload.serviceName,
      severity,
      fingerprint: fp,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrenceCount: 1,
      recentLogs: payload.recentLogs ?? [],
      commitHash: payload.commitHash,
      deployVersion: payload.deployVersion,
      reproduceCommand: payload.reproduceCommand,
      stackTrace: payload.stackTrace,
    };

    res.writeHead(202, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ fingerprint: fp, severity }),
    );

    // Process asynchronously — don't block the HTTP response
    setImmediate(() => this.deps.onNewIssue(obs).catch((e) => logger.error({ e }, 'onNewIssue error')));
  }

  private async handlePatchDecision(
    payload: PatchDecisionPayload,
    res: http.ServerResponse,
  ): Promise<void> {
    res.writeHead(202).end();
    setImmediate(() =>
      this.deps.onPatchDecision(payload).catch((e) =>
        logger.error({ e }, 'onPatchDecision error'),
      ),
    );
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  stop(): void {
    this.server.close();
  }
}
