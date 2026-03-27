import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
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
import { N8nClient } from './n8n/N8nClient.js';
import { WebhookRoutes } from './n8n/WebhookRoutes.js';
import { WebhookServer } from './n8n/WebhookServer.js';
import { AlertIngestFlow } from './flows/AlertIngestFlow.js';
import { PatchFlow } from './flows/PatchFlow.js';
import { CommandFlow } from './flows/CommandFlow.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('🗼 Bukery Control Tower starting...');

  const config = loadConfig();

  // ── 1. Core infrastructure ────────────────────────────────────────────────
  const registry = new AgentRegistry(config.tower.agents.enabled);
  const costTracker = new CostTracker(config.env.COST_LEDGER_PATH, config.tower.budgets, registry);
  const router = new TaskRouter(registry, costTracker);
  const executor = new ParallelExecutor(config.tower.routing.maxConcurrent);
  const evaluator = new ResultEvaluator(config.tower.evaluation.weights);
  const controlTower = new ControlTower({ registry, router, executor, evaluator, costTracker });

  // ── 2. Claude Code as the Control Tower brain ─────────────────────────────
  const decisionEngine = new DecisionEngine();
  const issueQueue = new IssueQueue(config.tower.issueQueue.persistPath);

  // ── 3. Telegram bot instance (shared by gateway + flows) ──────────────────
  const bot = new TelegramBot(config.env.TELEGRAM_BOT_TOKEN, { polling: false });

  const alertChatId = Number(process.env.TELEGRAM_ALERT_CHAT_ID ?? 0);
  const formatter = new TelegramFormatter();
  const n8nClient = new N8nClient();

  // ── 4. Agent availability check ───────────────────────────────────────────
  const available = await registry.getAvailableAgents();
  if (available.length === 0) {
    logger.warn('No agents available — check API keys in .env');
  } else {
    logger.info({ agents: available.map((a) => a.metadata.id) }, `${available.length} agent(s) available`);
  }

  // ── 5. Flow orchestrators ─────────────────────────────────────────────────
  const alertFlow = new AlertIngestFlow(issueQueue, decisionEngine, formatter, bot, n8nClient, alertChatId);
  const patchFlow = new PatchFlow(issueQueue, decisionEngine, formatter, bot, n8nClient, alertChatId);
  const commandFlow = new CommandFlow(controlTower, formatter, bot);

  // ── 6. n8n Webhook server ─────────────────────────────────────────────────
  const webhookPort = config.tower.n8n?.webhookPort ?? config.env.WEBHOOK_PORT ?? 3000;
  const webhookSecret = process.env.WEBHOOK_SECRET ?? '';
  const routes = new WebhookRoutes(alertFlow, patchFlow, commandFlow);
  const webhookServer = new WebhookServer(routes, webhookPort, webhookSecret);
  webhookServer.start();

  // ── 7. Telegram gateway (manual commands + button callbacks) ──────────────
  const gateway = new TelegramGateway(
    config.env.TELEGRAM_BOT_TOKEN,
    config.openclawPath,
    controlTower,
    { issueQueue, decisionEngine, n8nClient },
  );

  logger.info(
    { webhookPort, openIssues: issueQueue.getOpen().length },
    '✅ Control Tower is live',
  );

  // ── 8. Graceful shutdown ──────────────────────────────────────────────────
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
