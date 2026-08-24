export class LruCache<Key, Value> {
  readonly capacity: number;
  readonly #entries = new Map<Key, Value>();

  constructor(capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('LRU capacity must be a positive integer');
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: Key): Value | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: Key, value: Value): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next().value as Key | undefined;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  delete(key: Key): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  keys(): readonly Key[] {
    return [...this.#entries.keys()];
  }
}
