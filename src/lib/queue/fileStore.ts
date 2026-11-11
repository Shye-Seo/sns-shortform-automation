import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { QueueJobSchema, type QueueJob } from '../../types/queue';
import { ShortformError } from '../errors';
import type { QueueStore } from './jobQueue';

/**
 * JSON-file queue store for the CLI and for single-node demos.
 *
 * Not a production queue: one process writes at a time, and the whole table is
 * rewritten atomically (tmp + rename) on every mutation. It exists so `queue
 * run` and `queue status` in two separate CLI invocations see the same backlog,
 * and so the Redis adapter has a reference implementation to match.
 */
export class FileQueueStore implements QueueStore {
  private cache: Map<string, QueueJob> | null = null;
  /** All writes are serialised: concurrent workers must not rename the same file. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private writeCount = 0;

  constructor(private readonly filePath: string) {}

  private async load(): Promise<Map<string, QueueJob>> {
    if (this.cache) return this.cache;
    const map = new Map<string, QueueJob>();
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { jobs?: unknown[] };
      for (const entry of parsed.jobs ?? []) {
        const job = QueueJobSchema.safeParse(entry);
        if (job.success) map.set(job.data.id, job.data);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new ShortformError(`cannot read queue state at ${this.filePath}`, {
          code: 'CONFIG',
          cause: error,
          details: { path: this.filePath },
        });
      }
    }
    this.cache = map;
    return map;
  }

  private async flush(map: Map<string, QueueJob>): Promise<void> {
    const run = (): Promise<void> => this.writeSnapshot(map);
    // Chain even after a failure so one bad write does not wedge the store.
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async writeSnapshot(map: Map<string, QueueJob>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.writeCount += 1;
    const temp = `${this.filePath}.${process.pid}.${this.writeCount}.tmp`;
    const body = JSON.stringify({ version: 1, jobs: [...map.values()] }, null, 2);
    await writeFile(temp, body, 'utf8');
    await rename(temp, this.filePath);
  }

  async get(id: string): Promise<QueueJob | undefined> {
    const map = await this.load();
    const job = map.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async put(job: QueueJob): Promise<void> {
    const map = await this.load();
    map.set(job.id, structuredClone(job));
    await this.flush(map);
  }

  async delete(id: string): Promise<void> {
    const map = await this.load();
    if (map.delete(id)) await this.flush(map);
  }

  async all(): Promise<QueueJob[]> {
    const map = await this.load();
    return [...map.values()].map((job) => structuredClone(job));
  }

  async clear(): Promise<void> {
    this.cache = new Map();
    await this.flush(this.cache);
  }
}
