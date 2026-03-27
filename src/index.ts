import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { AgentRegistry } from './agents/AgentRegistry.js';
import { TaskRouter } from './core/TaskRouter.js';
import { ParallelExecutor } from './core/ParallelExecutor.js';
import { ResultEvaluator } from './core/ResultEvaluator.js';
import { CostTracker } from './core/CostTracker.js';
import { ControlTower } from './core/ControlTower.js';
import { TelegramGateway } from './gateway/TelegramGateway.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('🗼 Bukery Control Tower starting...');

  const config = loadConfig();

  // Wire up the dependency graph
  const registry = new AgentRegistry(config.tower.agents.enabled);
  const costTracker = new CostTracker(
    config.env.COST_LEDGER_PATH,
    config.tower.budgets,
    registry,
  );
  const router = new TaskRouter(registry, costTracker);
  const executor = new ParallelExecutor(config.tower.routing.maxConcurrent);
  const evaluator = new ResultEvaluator(config.tower.evaluation.weights);

  const controlTower = new ControlTower({
    registry,
    router,
    executor,
    evaluator,
    costTracker,
  });

  // Check which agents are online
  const available = await registry.getAvailableAgents();
  if (available.length === 0) {
    logger.warn('No agents available — check API keys in .env');
  } else {
    logger.info(
      { agents: available.map((a) => a.metadata.id) },
      `${available.length} agent(s) available`,
    );
  }

  // Start the Telegram gateway
  const gateway = new TelegramGateway(
    config.env.TELEGRAM_BOT_TOKEN,
    config.openclawPath,
    controlTower,
  );

  logger.info('✅ Control Tower is live — listening for Telegram messages');

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('Shutting down...');
    gateway.stop();
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
