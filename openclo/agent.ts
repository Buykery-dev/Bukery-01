/**
 * OpenClo Agent — 24h 로그 감시 + 이상 탐지 + Control Tower 알림
 *
 * 실행: tsx openclo/agent.ts
 * 역할: 로그 tail → 에러 감지 → fingerprint → POST /webhook/alert
 * 정책: 감지 + 알림만. 코드 수정 절대 없음.
 */

import { createReadStream, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const CONTROL_TOWER_URL = process.env.CONTROL_TOWER_URL ?? 'http://localhost:3000';
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET ?? '';
const SERVICE_NAME      = process.env.SERVICE_NAME ?? 'bukery-app';
const LOG_PATH          = process.env.LOG_PATH ?? '/var/log/bukery/app.log';
const DEPLOY_VERSION    = process.env.DEPLOY_VERSION ?? 'unknown';
const COMMIT_HASH       = process.env.COMMIT_HASH ?? 'unknown';
const POLL_INTERVAL_MS  = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const BUFFER_LINES      = Number(process.env.BUFFER_LINES ?? 50);

// 에러 감지 패턴 (severity 순)
const PATTERNS: Array<{ re: RegExp; severity: 'critical' | 'high' | 'medium' | 'low' }> = [
  { re: /\b(crash|fatal|oom|out of memory|segfault|unhandled rejection|process\.exit)\b/i, severity: 'critical' },
  { re: /\b(error|exception|uncaught|failed|timeout|econnrefused|unauthorized|500)\b/i,    severity: 'high'     },
  { re: /\b(warn|warning|deprecated|slow query|degraded)\b/i,                              severity: 'medium'   },
];

const recentLines: string[] = [];
let lastSize = 0;
let lastAlert = 0;
const ALERT_COOLDOWN_MS = 30_000; // 동일 에러 30초 쿨다운

async function sendAlert(errorLine: string, severity: string): Promise<void> {
  const now = Date.now();
  if (now - lastAlert < ALERT_COOLDOWN_MS) return;
  lastAlert = now;

  const payload = {
    serviceName:  SERVICE_NAME,
    errorMessage: errorLine.slice(0, 500),
    recentLogs:   [...recentLines].slice(-20),
    deployVersion: DEPLOY_VERSION,
    commitHash:   COMMIT_HASH,
    severity,
  };

  try {
    const res = await fetch(`${CONTROL_TOWER_URL}/webhook/alert`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[openclo] alert sent → ${res.status} (${severity}): ${errorLine.slice(0, 80)}`);
  } catch (e) {
    console.error('[openclo] failed to send alert:', e);
  }
}

function classifyLine(line: string): typeof PATTERNS[0] | null {
  for (const p of PATTERNS) {
    if (p.re.test(line)) return p;
  }
  return null;
}

async function tailNewLines(): Promise<void> {
  if (!existsSync(LOG_PATH)) return;

  const { size } = statSync(LOG_PATH);
  if (size <= lastSize) {
    // 로그 rotate 감지
    if (size < lastSize) lastSize = 0;
    return;
  }

  const stream = createReadStream(LOG_PATH, { start: lastSize, end: size });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    recentLines.push(line);
    if (recentLines.length > BUFFER_LINES) recentLines.shift();

    const match = classifyLine(line);
    if (match) {
      await sendAlert(line, match.severity);
    }
  }

  lastSize = size;
}

async function run(): Promise<void> {
  console.log(`[openclo] watching ${LOG_PATH} → ${CONTROL_TOWER_URL}`);
  // 초기 위치 설정 (기존 로그 무시, 신규 로그만 감시)
  if (existsSync(LOG_PATH)) {
    lastSize = statSync(LOG_PATH).size;
  }

  const loop = async (): Promise<void> => {
    try {
      await tailNewLines();
    } catch (e) {
      console.error('[openclo] poll error:', e);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };

  await loop();
}

run();
