import { EventEmitter } from 'node:events';

import { BlockyApiError, type BlockingStatus, type BlockyClient } from './blockyClient.js';

export interface ControllerLogger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}

/**
 * What the switches should show. Shared by the HAP and Matter front ends.
 */
export interface BlockySnapshot {
  /** false until the first successful status call */
  known: boolean;
  /** last status call succeeded */
  reachable: boolean;
  /** blocking is active */
  blockingEnabled: boolean;
  /** minutes of the pause switch that is on, or undefined */
  activePauseMinutes?: number;
  /** seconds until blocky turns blocking back on (0 = no timer) */
  autoEnableInSec: number;
}

/** true when the pause switch for `minutes` should show as on */
export function isPauseOn(snapshot: BlockySnapshot, minutes: number): boolean {
  return !snapshot.blockingEnabled && snapshot.activePauseMinutes === minutes;
}

interface ActionPlan {
  label: string;
  run: () => Promise<void>;
  /** blocky's status once the action has worked; shown right away, then confirmed by a status read */
  expected: BlockingStatus;
}

export interface BlockyControllerOptions {
  pauseMinutes: number[];
  pollIntervalSeconds: number;
}

/**
 * Owns all blocky state. Polls the status endpoint, runs enable and disable
 * actions one at a time, and emits 'change' when the shown state changes.
 */
export class BlockyController extends EventEmitter<{ change: [BlockySnapshot] }> {
  private status?: BlockingStatus;
  /** when `status` was read (ms since epoch) */
  private statusAt = 0;
  private reachable = false;
  private activePauseMinutes?: number;
  private lastEmitted = '';

  private pollTimer?: NodeJS.Timeout;
  private autoEnableTimer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  /** a refresh that is queued but hasn't started yet */
  private pendingRefresh?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly client: BlockyClient,
    private readonly log: ControllerLogger,
    private readonly options: BlockyControllerOptions,
  ) {
    super();
  }

  get snapshot(): BlockySnapshot {
    const enabled = this.status?.enabled ?? true;
    return {
      known: this.status !== undefined,
      reachable: this.reachable,
      blockingEnabled: enabled,
      activePauseMinutes: enabled ? undefined : this.activePauseMinutes,
      autoEnableInSec: enabled ? 0 : this.remainingSec(),
    };
  }

  /** blocky's countdown, less the time since it was read, so it keeps moving between polls */
  private remainingSec(): number {
    const atRead = this.status?.autoEnableInSec ?? 0;
    if (atRead <= 0) {
      return 0;
    }
    return Math.max(0, Math.round(atRead - (Date.now() - this.statusAt) / 1000));
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
    if (this.options.pollIntervalSeconds > 0) {
      this.pollTimer = setInterval(() => void this.refresh(), this.options.pollIntervalSeconds * 1000);
      this.pollTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.autoEnableTimer);
  }

  /**
   * Fetch the status from blocky. Errors are logged, not thrown.
   * Calls made while a refresh is still waiting in the queue share it, so a
   * slow or unresponsive blocky can't build up a backlog of polls.
   */
  refresh(): Promise<void> {
    if (this.pendingRefresh) {
      return this.pendingRefresh;
    }
    const run = this.enqueue(async () => {
      this.pendingRefresh = undefined;
      await this.fetchStatusOrMarkUnreachable();
    });
    this.pendingRefresh = run;
    return run;
  }

  /** Main switch: true turns blocking on, false disables it with no time limit. */
  setBlocking(enabled: boolean): Promise<void> {
    return this.runPlanned(() => this.blockingPlan(enabled));
  }

  /** Pause switch: disable blocking for `minutes`. */
  pause(minutes: number): Promise<void> {
    return this.runPlanned(() => this.pausePlan(minutes));
  }

  /**
   * Turning a pause switch off turns blocking back on, but only if that pause
   * is the active one. Otherwise there is nothing to do.
   */
  cancelPause(minutes: number): Promise<void> {
    return this.runPlanned(() => (isPauseOn(this.snapshot, minutes) ? this.blockingPlan(true) : undefined));
  }

  /** Flip the main switch (no `minutes`) or a pause switch, based on the state when the request runs. */
  toggle(minutes?: number): Promise<void> {
    return this.runPlanned(() => {
      const current = this.snapshot;
      if (minutes === undefined) {
        return this.blockingPlan(!current.blockingEnabled);
      }
      return isPauseOn(current, minutes) ? this.blockingPlan(true) : this.pausePlan(minutes);
    });
  }

  private blockingPlan(enabled: boolean): ActionPlan {
    return {
      label: enabled ? 'enable blocking' : 'disable blocking',
      run: async () => {
        if (enabled) {
          await this.client.enable();
        } else {
          await this.client.disable();
        }
        this.activePauseMinutes = undefined;
      },
      expected: enabled ? { enabled: true, autoEnableInSec: 0 } : { enabled: false, autoEnableInSec: 0 },
    };
  }

  private pausePlan(minutes: number): ActionPlan {
    return {
      label: `pause blocking for ${minutes} minutes`,
      run: async () => {
        await this.client.disable(minutes);
        this.activePauseMinutes = minutes;
      },
      expected: { enabled: false, autoEnableInSec: minutes * 60 },
    };
  }

  /**
   * Queue an action. `decide` runs when the action's turn comes, so it sees the
   * state left by any earlier actions (a quick on-then-off is handled in order).
   * When it returns undefined there is nothing to do, and the switches are
   * re-sent so the one the user flipped moves back.
   */
  private runPlanned(decide: () => ActionPlan | undefined): Promise<void> {
    return this.enqueue(async () => {
      const plan = decide();
      if (!plan) {
        this.emitIfChanged(true);
        return;
      }
      this.log.info(`Blocky: ${plan.label}`);
      try {
        await plan.run();
      } catch (error) {
        if (error instanceof BlockyApiError && error.status !== undefined) {
          // blocky answered but refused the request (e.g. an unknown group), so it's
          // still reachable. Read its real state, so the switches show what it's doing.
          this.log.error(error.message);
          await this.fetchStatusOrMarkUnreachable();
        } else {
          this.markUnreachable(error);
        }
        // Re-send the state even if unchanged, so the switch the user just flipped moves back.
        this.emitIfChanged(true);
        throw error;
      }
      // Show the result now and confirm it with a status read afterwards, instead of
      // making the caller wait for that read too: HomeKit gives a write about 10s.
      if (!this.reachable) {
        this.log.info('Connected to blocky');
      }
      this.reachable = true;
      this.applyStatus(plan.expected);
      void this.refresh();
    });
  }

  private async fetchStatusOrMarkUnreachable(): Promise<void> {
    try {
      await this.fetchStatus();
    } catch (error) {
      this.markUnreachable(error);
    }
  }

  private async fetchStatus(): Promise<void> {
    const status = await this.client.status();
    if (!this.reachable) {
      this.log.info(`Connected to blocky (blocking ${status.enabled ? 'enabled' : 'disabled'})`);
    }
    this.reachable = true;
    this.applyStatus(status);
  }

  private applyStatus(status: BlockingStatus): void {
    this.status = status;
    this.statusAt = Date.now();
    this.reconcilePause(status);
    this.scheduleAutoEnableCheck(status);
    this.emitIfChanged();
  }

  /** Work out which pause switch should be on, given blocky's status. */
  private reconcilePause(status: BlockingStatus): void {
    const remaining = status.autoEnableInSec ?? 0;
    if (status.enabled || remaining <= 0) {
      // Blocking is on, or off with no timer. No pause switch applies.
      this.activePauseMinutes = undefined;
      return;
    }
    if (this.activePauseMinutes !== undefined && remaining <= this.activePauseMinutes * 60 + 5) {
      return; // the pause we started is still running
    }
    // A timed disable we didn't start (another client, or a restart).
    // Pick the shortest pause that covers the remaining time.
    const sorted = [...this.options.pauseMinutes].sort((a, b) => a - b);
    this.activePauseMinutes = sorted.find((m) => m * 60 >= remaining) ?? sorted[sorted.length - 1];
  }

  /** Check again just after blocky's timer should have turned blocking back on, so the switches update quickly. */
  private scheduleAutoEnableCheck(status: BlockingStatus): void {
    clearTimeout(this.autoEnableTimer);
    const remaining = status.autoEnableInSec ?? 0;
    if (this.stopped || status.enabled || remaining <= 0) {
      return;
    }
    this.autoEnableTimer = setTimeout(() => void this.refresh(), (remaining + 1) * 1000);
    this.autoEnableTimer.unref?.();
  }

  private markUnreachable(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.reachable || this.status === undefined) {
      this.log.error(message);
    } else {
      this.log.debug(message);
    }
    this.reachable = false;
    this.emitIfChanged();
  }

  private emitIfChanged(force = false): void {
    const snap = this.snapshot;
    // autoEnableInSec counts down on every poll; leave it out of the comparison
    const key = JSON.stringify({ ...snap, autoEnableInSec: snap.autoEnableInSec > 0 });
    if (!force && key === this.lastEmitted) {
      return;
    }
    this.lastEmitted = key;
    this.emit('change', snap);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
