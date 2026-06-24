// Injectable clock so the TTL reaper is deterministic under test.
//
// - SystemClock: real wall time, drives the reaper on a timer.
// - ManualClock: time only moves when advance() is called (via /_test/advance-clock),
//   and each advance synchronously runs every registered tick callback.
export interface Clock {
  now(): number;
  onTick(cb: () => void): void;
  toIso(ms: number): string;
}

export class SystemClock implements Clock {
  private readonly timers: NodeJS.Timeout[] = [];

  now(): number {
    return Date.now();
  }

  onTick(cb: () => void): void {
    const timer = setInterval(cb, 250);
    timer.unref();
    this.timers.push(timer);
  }

  toIso(ms: number): string {
    return new Date(ms).toISOString();
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
  }
}

export class ManualClock implements Clock {
  private current: number;
  private readonly callbacks: Array<() => void> = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  onTick(cb: () => void): void {
    this.callbacks.push(cb);
  }

  toIso(ms: number): string {
    return new Date(ms).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
    for (const cb of this.callbacks) {
      cb();
    }
  }
}
