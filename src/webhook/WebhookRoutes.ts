import {
  OpenCloAlertSchema,
  CodexPatchCompleteSchema,
  PatchDecisionSchema,
  TelegramTaskSchema,
} from '../types/webhook.js';
import type { AlertIngestFlow } from '../flows/AlertIngestFlow.js';
import type { PatchFlow } from '../flows/PatchFlow.js';
import type { CommandFlow } from '../flows/CommandFlow.js';
import { logger } from '../utils/logger.js';

/**
 * WebhookRoutes — dispatch table for all inbound OpenClo webhook calls.
 *
 * Routes:
 *   POST /webhook/alert                ← OpenClo error alert
 *   POST /webhook/codex-patch-complete ← Codex patch done
 *   POST /webhook/patch-decision       ← human approve/reject from Telegram button
 *   POST /webhook/task                 ← manual Telegram command
 *   GET  /webhook/health               ← health check
 */
export class WebhookRoutes {
  constructor(
    private alertFlow: AlertIngestFlow,
    private patchFlow: PatchFlow,
    private commandFlow: CommandFlow,
  ) {}

  async dispatch(method: string, path: string, body: unknown): Promise<unknown> {
    logger.debug({ method, path }, 'Webhook dispatch');

    if (method === 'GET' && path === '/webhook/health') {
      return { status: 'ok', ts: new Date().toISOString() };
    }

    if (method !== 'POST') {
      throw Object.assign(new Error('Method Not Allowed'), { statusCode: 405 });
    }

    switch (path) {
      case '/webhook/alert': {
        const payload = OpenCloAlertSchema.parse(body);
        return this.alertFlow.handle(payload);
      }
      case '/webhook/codex-patch-complete': {
        const payload = CodexPatchCompleteSchema.parse(body);
        return this.patchFlow.handlePatchComplete(payload);
      }
      case '/webhook/patch-decision': {
        const payload = PatchDecisionSchema.parse(body);
        return this.patchFlow.handleDecision(payload);
      }
      case '/webhook/task': {
        const payload = TelegramTaskSchema.parse(body);
        return this.commandFlow.handle(payload);
      }
      default:
        throw Object.assign(new Error(`Unknown route: ${path}`), { statusCode: 404 });
    }
  }
}
