import http from 'node:http';
import type { WebhookRoutes } from './WebhookRoutes.js';
import { logger } from '../utils/logger.js';

/**
 * WebhookServer — lightweight HTTP server receiving inbound OpenClo calls.
 *
 * Security: validates X-Webhook-Secret header on every request.
 * All routing is delegated to WebhookRoutes.
 */
export class WebhookServer {
  private server: http.Server;

  constructor(
    private routes: WebhookRoutes,
    private port: number = 3000,
    private secret: string = '',
  ) {
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err) => {
        logger.error({ err }, 'Webhook unhandled error');
        res.writeHead(500).end('Internal Server Error');
      });
    });
  }

  start(): void {
    this.server.listen(this.port, () => {
      logger.info({ port: this.port }, 'Webhook server listening');
    });
  }

  stop(): void {
    this.server.close();
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Validate shared secret (skip if secret is empty — dev mode)
    if (this.secret) {
      const incoming = req.headers['x-webhook-secret'];
      if (incoming !== this.secret) {
        res.writeHead(401).end('Unauthorized');
        return;
      }
    }

    const url = new URL(req.url ?? '/', `http://localhost`);
    const method = req.method ?? 'GET';

    let body: unknown = {};
    if (method === 'POST') {
      try {
        body = await this.readBody(req);
      } catch {
        res.writeHead(400).end('Bad Request: invalid JSON');
        return;
      }
    }

    try {
      const result = await this.routes.dispatch(method, url.pathname, body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify(result ?? { ok: true }),
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      res.writeHead(statusCode, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: message }),
      );
    }
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
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
}
