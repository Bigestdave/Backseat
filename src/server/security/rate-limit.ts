type WindowEntry = { count: number; resetAt: number };

/**
 * Deliberately small, process-local protection for this one-instance MVP.
 * It is not a substitute for a shared limiter when the backend is scaled out.
 */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  allow(key: string, maximum: number, windowMs: number, now = Date.now()): boolean {
    if (this.entries.size > 10_000) this.prune(now);
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (current.count >= maximum) return false;
    current.count += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
