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
import { GitHubClient } from './github/GitHubClient.js';
import { TelegramGateway } from './gateway/TelegramGateway.js';
import { TelegramFormatter } from './gateway/TelegramFormatter.js';
import { WebhookRoutes } from './webhook/WebhookRoutes.js';
import { WebhookServer } from './webhook/WebhookServer.js';
import { AlertIngestFlow } from './flows/AlertIngestFlow.js';
import { PatchFlow } from './flows/PatchFlow.js';
import { CommandFlow } from './flows/CommandFlow.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('🗼 Bukery Control Tower starting...');

  const config = loadConfig();

  // ── 1. 코어 인프라 ─────────────────────────────────────────────────────────
  const registry    = new AgentRegistry(config.tower.agents.enabled);
  const costTracker = new CostTracker(config.env.COST_LEDGER_PATH, config.tower.budgets, registry);
  const router      = new TaskRouter(registry, costTracker);
  const executor    = new ParallelExecutor(config.tower.routing.maxConcurrent);
  const evaluator   = new ResultEvaluator(config.tower.evaluation.weights);
  const tower       = new ControlTower({ registry, router, executor, evaluator, costTracker });

  // ── 2. 판단 엔진 (Claude Code) ─────────────────────────────────────────────
  const decisionEngine = new DecisionEngine();
  const issueQueue     = new IssueQueue(config.tower.issueQueue.persistPath);

  // ── 3. 공유 의존성 ──────────────────────────────────────────────────────────
  const bot        = new TelegramBot(config.env.TELEGRAM_BOT_TOKEN, { polling: false });
  const formatter  = new TelegramFormatter();
  const github     = new GitHubClient();
  const alertChatId = Number(process.env.TELEGRAM_ALERT_CHAT_ID ?? 0);

  // ── 4. 에이전트 가용성 확인 ────────────────────────────────────────────────
  const available = await registry.getAvailableAgents();
  logger.info(
    available.length
      ? { agents: available.map((a) => a.metadata.id) }
      : { warn: 'No agents — check API keys' },
    `${available.length} agent(s) available`,
  );

  // ── 5. 플로우 오케스트레이터 ───────────────────────────────────────────────
  const alertFlow   = new AlertIngestFlow(issueQueue, decisionEngine, formatter, bot, alertChatId);
  const patchFlow   = new PatchFlow(issueQueue, decisionEngine, formatter, bot, alertChatId);
  const commandFlow = new CommandFlow(tower, formatter, bot);

  // ── 6. Webhook 서버 (Nanoclaw 수신) ─────────────────────────────────────────
  const port   = config.tower.webhook?.port ?? config.env.WEBHOOK_PORT ?? 3000;
  const secret = process.env.WEBHOOK_SECRET ?? '';
  const routes = new WebhookRoutes(alertFlow, patchFlow, commandFlow);
  const webhookServer = new WebhookServer(routes, port, secret);
  webhookServer.start();

  // ── 7. Telegram 게이트웨이 (명령 + 버튼 콜백) ─────────────────────────────
  const gateway = new TelegramGateway(
    config.env.TELEGRAM_BOT_TOKEN,
    config.openclawPath,
    tower,
    { issueQueue, decisionEngine, patchFlow },
  );

  logger.info({ port, openIssues: issueQueue.getOpen().length }, '✅ Control Tower live');

  // ── 8. 종료 처리 ───────────────────────────────────────────────────────────
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
