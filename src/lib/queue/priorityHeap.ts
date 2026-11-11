export type Comparator<T> = (a: T, b: T) => number;

/**
 * Binary min-heap over a comparator. The scheduler keeps waiting job ids here
 * so `reserve` is O(log n) on a 50k-job backlog instead of sorting the whole
 * table on every poll.
 */
export class BinaryHeap<T> {
  private items: T[] = [];

  constructor(private readonly compare: Comparator<T>) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(value: T): void {
    this.items.push(value);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const root = this.items[0];
    const last = this.items.pop() as T;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return root;
  }

  clear(): void {
    this.items = [];
  }

  toArray(): T[] {
    return [...this.items];
  }

  /** Drain in comparator order. O(n log n), used by tests and snapshots. */
  drain(): T[] {
    const out: T[] = [];
    for (let value = this.pop(); value !== undefined; value = this.pop()) out.push(value);
    return out;
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.compare(this.items[child], this.items[parent]) >= 0) break;
      [this.items[child], this.items[parent]] = [this.items[parent], this.items[child]];
      child = parent;
    }
  }

  private siftDown(index: number): void {
    const length = this.items.length;
    let parent = index;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let best = parent;
      if (left < length && this.compare(this.items[left], this.items[best]) < 0) best = left;
      if (right < length && this.compare(this.items[right], this.items[best]) < 0) best = right;
      if (best === parent) return;
      [this.items[parent], this.items[best]] = [this.items[best], this.items[parent]];
      parent = best;
    }
  }
}
