/**
 * Owns cached ContextManager sessions and their idle lifetime for application adapters.
 * Persistence is supplied by the application; this module has no database or agent dependencies.
 * Dirty durable entries are persisted before eviction. Active and explicitly nonpersistent sessions
 * are protected from automatic eviction; the byte budget estimates owned data, not process RSS.
 * Borrowed contexts and their derived handles must not be retained beyond the use callback.
 */

import { ContextManager } from './context-manager.js';
import type { ContextSnapshot } from './types.js';

/** Required retention policy and application-owned snapshot I/O for managed sessions. */
export interface ContextSessionsOptions<T extends ContextManager = ContextManager> {
  idleTtlMs: number;
  maxRetainedBytes: number;
  create: (key: string) => T;
  load: (key: string) => Promise<ContextSnapshot | null>;
  /** The context is borrowed read-only during persistence for application-owned checkpoint validation. */
  persist: (key: string, snapshot: ContextSnapshot, context: T) => Promise<void>;
}

/** One cached context; snapshots are generated for persistence, never retained as a second cache. */
interface SessionEntry<T extends ContextManager> {
  context: T;
  persist: boolean;
  savedRevision: number;
  lastUsedAt: number;
  accountedBytes: number;
  evicting: boolean;
}

/** Timer shape works in browser runtimes and uses Node/Bun unref when available. */
interface TimerRuntime {
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (timer: unknown) => void;
}

/**
 * Serializes access per key and evicts idle durable contexts by TTL then LRU.
 * Nonpersistent entries never load/save and survive until explicit release/discard/close.
 * Capacity failures preserve data and propagate; active working peaks are not a hard heap cap.
 */
export class ContextSessions<T extends ContextManager = ContextManager> {
  private readonly entries = new Map<string, SessionEntry<T>>();
  private readonly active = new Set<string>();
  private retainedBytes = 0;
  private sweeping: Promise<void> | undefined;
  private timer: unknown | undefined;
  private closing = false;
  private closed = false;

  /** Require explicit valid policy and storage callbacks rather than inventing retention defaults. */
  constructor(private readonly options: ContextSessionsOptions<T>) {
    for (const [name, value] of [['idleTtlMs', options.idleTtlMs], ['maxRetainedBytes', options.maxRetainedBytes]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`[Mosaic] ${name} must be a positive safe integer`);
    }
    if (typeof options.create !== 'function' || typeof options.load !== 'function' || typeof options.persist !== 'function') {
      throw new Error('[Mosaic] Session create, load and persist callbacks are required');
    }
  }

  /** Number of resident session contexts, excluding loads that have not completed. */
  get sessionCount(): number {
    return this.entries.size;
  }

  /** Number of active callbacks or initial loads, which cannot be evicted. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Estimated owned data including in-progress mutations; does not serialize any context. */
  get estimatedRetainedBytes(): number {
    let bytes = this.retainedBytes;
    for (const key of this.active) {
      const entry = this.entries.get(key);
      if (entry) bytes += this.entryBytes(key, entry) - entry.accountedBytes;
    }
    return bytes;
  }

  /**
   * Borrow one context exclusively for the callback; loading occurs only on a cache miss.
   * The callback owns its transactions and must close them before returning. Errors preserve state.
   * The persistence mode cannot change while the key is resident; false requires explicit release.
   */
  async use<R>(key: string, work: (context: T) => R | Promise<R>, options: { persist?: boolean } = {}): Promise<R> {
    this.assertOpen();
    this.assertKey(key);
    if (options.persist !== undefined && typeof options.persist !== 'boolean') throw new Error('[Mosaic] Session persist must be boolean');
    const persistent = options.persist !== false;
    let entry = this.entries.get(key);
    if (this.active.has(key) || entry?.evicting) throw new Error(`[Mosaic] Session is busy: ${key}`);
    if (entry && entry.persist !== persistent) throw new Error(`[Mosaic] Session persistence mode cannot change: ${key}`);

    this.active.add(key);
    let result!: R;
    let failed = false;
    let failure: unknown;
    try {
      if (!entry) {
        const snapshot = persistent ? await this.options.load(key) : null;
        if (snapshot === undefined) throw new Error('[Mosaic] Session load must return a snapshot or null');
        const context = this.options.create(key);
        if (snapshot !== null) context.restore(snapshot);
        entry = {
          context,
          persist: persistent,
          savedRevision: context.revision,
          lastUsedAt: Date.now(),
          accountedBytes: 0,
          evicting: false,
        };
        entry.accountedBytes = this.entryBytes(key, entry);
        this.entries.set(key, entry);
        this.retainedBytes += entry.accountedBytes;
      }
      result = await work(entry.context);
      if (entry.context.transaction?.status === 'open') throw new Error(`[Mosaic] Session callback left a transaction open: ${key}`);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (entry) {
        const bytes = this.entryBytes(key, entry);
        this.retainedBytes += bytes - entry.accountedBytes;
        entry.accountedBytes = bytes;
        entry.lastUsedAt = Date.now();
        this.entries.delete(key);
        this.entries.set(key, entry);
      }
      this.active.delete(key);
    }

    try {
      await this.sweep();
    } catch (error) {
      if (failed) {
        const combined = new Error('[Mosaic] Session work and retention both failed');
        Object.assign(combined, { cause: failure, retentionError: error });
        throw combined;
      }
      throw error;
    }
    if (failed) throw failure;
    return result;
  }

  /** Persist dirty durable state before releasing it; explicit release discards nonpersistent state. */
  async release(key: string): Promise<void> {
    this.assertOpen();
    this.assertKey(key);
    if (this.active.has(key)) throw new Error(`[Mosaic] Session is busy: ${key}`);
    const entry = this.entries.get(key);
    if (entry) await this.evict(key, entry);
  }

  /** Discard idle memory for an application-owned reset; this neither persists nor deletes storage. */
  discard(key: string): void {
    this.assertOpen();
    this.assertKey(key);
    const entry = this.entries.get(key);
    if (this.active.has(key) || entry?.evicting) throw new Error(`[Mosaic] Session is busy: ${key}`);
    if (entry) this.remove(key, entry);
  }

  /** Persist/evict expired idle durable sessions, then the least recently used eligible entries. */
  async sweep(): Promise<void> {
    this.assertOpen();
    if (this.sweeping) return this.sweeping;
    const operation = this.sweepIdle();
    this.sweeping = operation;
    try {
      await operation;
    } finally {
      if (this.sweeping === operation) this.sweeping = undefined;
    }
  }

  /** Start the owned idle sweep timer; every asynchronous failure reaches the required handler. */
  start(onError: (error: unknown) => void): void {
    this.assertOpen();
    if (typeof onError !== 'function') throw new Error('[Mosaic] Session sweep error handler is required');
    if (this.timer !== undefined) throw new Error('[Mosaic] Session sweep timer is already running');
    const runtime = globalThis as unknown as TimerRuntime;
    this.timer = runtime.setInterval(() => {
      void this.sweep().catch(onError);
    }, Math.min(this.options.idleTtlMs, 2_147_483_647));
    const timer = this.timer as { unref?: () => void } | null;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Stop the timer and release idle entries; active work rejects shutdown without losing state. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing || this.active.size) throw new Error('[Mosaic] Cannot close sessions while busy');
    this.closing = true;
    this.stopTimer();
    try {
      if (this.sweeping) await this.sweeping;
      if ([...this.entries.values()].some((entry) => entry.evicting)) throw new Error('[Mosaic] Cannot close sessions while busy');
      for (const [key, entry] of this.entries) await this.evict(key, entry);
      this.closed = true;
    } finally {
      this.closing = false;
    }
  }

  /** Apply retention only to idle durable entries; capacity failure never discards protected data. */
  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.eligible(key, entry) && now - entry.lastUsedAt >= this.options.idleTtlMs) await this.evict(key, entry);
    }
    for (const [key, entry] of this.entries) {
      if (this.estimatedRetainedBytes <= this.options.maxRetainedBytes) return;
      if (this.eligible(key, entry)) await this.evict(key, entry);
    }
    if (this.estimatedRetainedBytes > this.options.maxRetainedBytes) throw new Error('[Mosaic] Retained session capacity exceeded by protected data');
  }

  /** Decide eligibility without changing active, transient or transaction state. */
  private eligible(key: string, entry: SessionEntry<T>): boolean {
    return entry.persist && !entry.evicting && !this.active.has(key) && entry.context.transaction?.status !== 'open';
  }

  /** Keep a dirty entry resident until its application-owned persistence callback succeeds. */
  private async evict(key: string, entry: SessionEntry<T>): Promise<void> {
    if (this.active.has(key) || entry.evicting) throw new Error(`[Mosaic] Session is busy: ${key}`);
    if (entry.context.transaction?.status === 'open') throw new Error(`[Mosaic] Cannot release a session with an open transaction: ${key}`);
    entry.evicting = true;
    try {
      if (entry.persist && entry.savedRevision !== entry.context.revision) {
        const revision = entry.context.revision;
        await this.options.persist(key, entry.context.snapshot(), entry.context);
        entry.savedRevision = revision;
      }
      this.remove(key, entry);
    } finally {
      entry.evicting = false;
    }
  }

  /** Remove one resident entry and its cached estimate after its lifetime obligation is satisfied. */
  private remove(key: string, entry: SessionEntry<T>): void {
    this.entries.delete(key);
    this.retainedBytes -= entry.accountedBytes;
  }

  /** Include the session key and entry overhead without traversing its context data. */
  private entryBytes(key: string, entry: SessionEntry<T>): number {
    return 96 + key.length * 2 + entry.context.estimatedRetainedBytes;
  }

  /** Stop only this manager's timer when its owner shuts it down. */
  private stopTimer(): void {
    if (this.timer === undefined) return;
    (globalThis as unknown as TimerRuntime).clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Refuse new work once shutdown begins rather than recreating retired state. */
  private assertOpen(): void {
    if (this.closed || this.closing) throw new Error('[Mosaic] Context sessions are closed');
  }

  /** Reject missing identity rather than merging unrelated sessions under a default key. */
  private assertKey(key: string): void {
    if (typeof key !== 'string' || !key.trim()) throw new Error('[Mosaic] Session key must be nonempty');
  }
}
