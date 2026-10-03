/** An unbounded async queue: push from anywhere, consume with `for await`. `end()` finishes it. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  items: T[] = [];
  waiters: ((r: IteratorResult<T>) => void)[] = [];
  ended = false;

  push(item: T): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
