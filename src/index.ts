import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { AgentRegistry } from './agents/AgentRegistry.js';
import { TaskRouter } from './core/TaskRouter.js';
import { ParallelExecutor } from './core/ParallelExecutor.js';
import { ResultEvaluator } from './core/ResultEvaluator.js';
import { CostTracker } from './core/CostTracker.js';
import { ControlTower } from './core/ControlTower.js';
import { DecisionEngine } from './core/DecisionEngine.js';
import { IssueQueue } from './queue/IssueQueue.js';
import { TelegramGateway } from './gateway/TelegramGateway.js';
import { TelegramFormatter } from './gateway/TelegramFormatter.js';
import { WebhookServer } from './n8n/WebhookServer.js';
import type { IssueObservability } from './types/issue.js';
import type { PatchDecisionPayload } from './n8n/WebhookServer.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('🗼 Bukery Control Tower starting...');

  const config = loadConfig();

  // ── Core infrastructure ───────────────────────────────────────────────────
  const registry = new AgentRegistry(config.tower.agents.enabled);
  const costTracker = new CostTracker(
    config.env.COST_LEDGER_PATH,
    config.tower.budgets,
    registry,
  );
  const router = new TaskRouter(registry, costTracker);
  const executor = new ParallelExecutor(config.tower.routing.maxConcurrent);
  const evaluator = new ResultEvaluator(config.tower.evaluation.weights);

  // ── Claude Code as the Control Tower brain ────────────────────────────────
  const decisionEngine = new DecisionEngine();
  const issueQueue = new IssueQueue(config.tower.issueQueue.persistPath);

  const controlTower = new ControlTower({
    registry,
    router,
    executor,
    evaluator,
    costTracker,
  });

  // ── Agent availability check ──────────────────────────────────────────────
  const available = await registry.getAvailableAgents();
  if (available.length === 0) {
    logger.warn('No agents available — check API keys in .env');
  } else {
    logger.info(
      { agents: available.map((a) => a.metadata.id) },
      `${available.length} agent(s) available`,
    );
  }

  // ── Telegram formatter (shared) ───────────────────────────────────────────
  const formatter = new TelegramFormatter();

  // ── n8n Webhook server ────────────────────────────────────────────────────
  const webhookServer = new WebhookServer(
    {
      issueQueue,
      decisionEngine,

      async onNewIssue(obs: IssueObservability): Promise<void> {
        const issue = issueQueue.upsert(obs);
        if (!issue) return;  // suppressed by cooldown

        // Claude Code analyses the issue and decides next action
        issueQueue.updateStatus(issue.id, 'analyzing');
        const decision = await decisionEngine.analyseIssue(issue);
        issueQueue.updateStatus(issue.id, 'patch_requested', { decision });

        // Format and send Telegram alert
        const { text, replyMarkup } = formatter.formatIssueAlert({
          ...issue,
          decision,
        });
        logger.info({ issueId: issue.id, assignTo: decision.assignTo }, 'Alert sent to Telegram');
        logger.debug({ text, replyMarkup }, 'Telegram alert payload');
      },

      async onPatchDecision(payload: PatchDecisionPayload): Promise<void> {
        const issue = issueQueue.getById(payload.issueId);
        if (!issue) return;

        if (payload.approved) {
          issueQueue.updateStatus(payload.issueId, 'approved');
          logger.info({ issueId: payload.issueId, by: payload.approvedBy }, 'Patch approved');
        } else {
          issueQueue.updateStatus(payload.issueId, 'open');
          logger.info({ issueId: payload.issueId }, 'Patch rejected — re-opened');
        }
      },
    },
    config.tower.n8n?.webhookPort ?? 3000,
  );

  // ── Telegram gateway (manual commands from allowed group) ─────────────────
  const gateway = new TelegramGateway(
    config.env.TELEGRAM_BOT_TOKEN,
    config.openclawPath,
    controlTower,
  );

  logger.info({
    webhookPort: config.tower.n8n?.webhookPort ?? 3000,
    openIssues: issueQueue.getOpen().length,
  }, '✅ Control Tower is live');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = (): void => {
    logger.info('Shutting down...');
    gateway.stop();
    webhookServer.stop();
    logger.info(costTracker.getDailySummary());
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
