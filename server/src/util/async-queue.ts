// A minimal push/pull async queue used to bridge event-emitter style
// notifications into `for await` consumers (SSE streams).
export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolveNext = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
