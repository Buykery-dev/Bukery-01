import { logger } from './logger.js';

/**
 * Retry an async operation with exponential backoff.
 * @param fn        The async function to retry
 * @param maxRetries Maximum number of attempts (default 4)
 * @param baseDelayMs Base delay in ms (doubles each attempt, default 2000)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 4,
  baseDelayMs = 2000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn({ attempt, maxRetries, delay }, 'Retrying after error');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
