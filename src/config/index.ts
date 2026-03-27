import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '../types/agent.js';
import type { BudgetConfig } from '../types/cost.js';
import type { EvaluationWeights } from '../types/evaluation.js';

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CURSOR_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  COST_LEDGER_PATH: z.string().default('./cost-ledger.json'),
});

export type Env = z.infer<typeof EnvSchema>;

interface TowerConfig {
  agents: { enabled: AgentId[]; disabled: AgentId[] };
  routing: { defaultMode: string; maxConcurrent: number };
  evaluation: { weights: EvaluationWeights };
  budgets: BudgetConfig;
}

export interface AppConfig {
  env: Env;
  tower: TowerConfig;
  openclawPath: string;
}

export function loadConfig(): AppConfig {
  // Validate environment
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    const issues = envResult.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }

  // Load control tower JSON config
  const towerPath = new URL('../../src/config/control-tower.json', import.meta.url).pathname;
  const tower = JSON.parse(fs.readFileSync(towerPath, 'utf-8')) as TowerConfig;

  // Resolve openclaw.json path (project root)
  const openclawPath = path.resolve(process.cwd(), 'openclaw.json');

  return { env: envResult.data, tower, openclawPath };
}
