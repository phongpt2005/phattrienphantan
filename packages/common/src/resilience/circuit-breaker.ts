export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(public readonly name_: string) {
    super(`Circuit "${name_}" đang mở`);
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Quá thời gian chờ ${ms}ms`);
  }
}

export interface CircuitBreakerOptions {
  /** Số lần lỗi liên tiếp để mở circuit */
  failureThreshold?: number;
  /** Sau bao lâu (ms) thử lại một request (HALF_OPEN) */
  resetTimeoutMs?: number;
}

/**
 * Circuit breaker nhỏ gọn cho từng node phòng ban:
 * CLOSED -> (N lỗi liên tiếp) -> OPEN -> (hết resetTimeout) -> HALF_OPEN -> thành công: CLOSED / lỗi: OPEN.
 * Khi OPEN, lời gọi bị từ chối ngay (không tốn timeout) để Search đi thẳng sang fallback.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly name: string,
    private readonly opts: CircuitBreakerOptions = {},
  ) {}

  get currentState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= (this.opts.resetTimeoutMs ?? 10000)) {
      return 'HALF_OPEN';
    }
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === 'OPEN') throw new CircuitOpenError(this.name);
    if (state === 'HALF_OPEN') {
      if (this.probing) throw new CircuitOpenError(this.name); // chỉ cho 1 request thăm dò
      this.probing = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (state === 'HALF_OPEN') this.probing = false;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= (this.opts.failureThreshold ?? 3)) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}

/** Giới hạn thời gian cho một Promise (hủy qua AbortSignal nếu hàm hỗ trợ). */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new TimeoutError(ms)));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
