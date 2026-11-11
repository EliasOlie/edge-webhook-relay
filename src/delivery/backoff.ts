/** Cloudflare Queues accepts retry delays up to 12 hours. */
export const MAX_QUEUE_DELAY_SECONDS = 43_200;

/**
 * Exponential backoff for queue retries: base * 2^(attempt-1), capped.
 * `attempt` is the 1-based attempt that just failed (Message.attempts).
 * Example with base=10, cap=3600: 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600...
 */
export function backoffSeconds(attempt: number, baseSeconds = 10, capSeconds = 3600): number {
  const exp = baseSeconds * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, capSeconds, MAX_QUEUE_DELAY_SECONDS);
}
