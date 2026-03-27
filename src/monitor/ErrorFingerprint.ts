import crypto from 'node:crypto';
import type { Severity } from '../types/issue.js';

/**
 * Normalise an error message/stack so that dynamic parts
 * (timestamps, IDs, line numbers) are stripped before hashing.
 * This lets us deduplicate the same logical error across occurrences.
 */
export function normalise(raw: string): string {
  return raw
    // Remove timestamps: 2026-03-27T08:42:00.000Z, [08:42:00]
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>')
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '<ts>')
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    // Remove hex IDs (32+ chars)
    .replace(/[0-9a-f]{32,}/gi, '<hex>')
    // Remove file line numbers: (:123:45)
    .replace(/:\d+:\d+\)/g, ':<ln>)')
    .replace(/:\d+\)/g, ':<ln>)')
    // Remove specific numeric values that change per-request
    .replace(/\b\d{5,}\b/g, '<num>')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);   // cap at 512 chars for the hash input
}

/** Generate a short 8-char hex fingerprint from a normalised error signature. */
export function fingerprint(errorMessage: string, stackTrace?: string): string {
  const input = normalise(errorMessage) + (stackTrace ? normalise(stackTrace) : '');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/** Classify severity from common keywords in the error message. */
export function classifySeverity(message: string): Severity {
  const lower = message.toLowerCase();
  if (
    /\b(crash|fatal|oom|out of memory|segfault|panic|unhandled rejection|process exit)\b/.test(lower)
  )
    return 'critical';
  if (/\b(error|exception|failed|timeout|refused|unauthorized|403|500)\b/.test(lower))
    return 'high';
  if (/\b(warn|warning|deprecated|slow|degraded)\b/.test(lower)) return 'medium';
  return 'low';
}
