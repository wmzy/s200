/**
 * The shared incremental event-loop-utilization reader — one
 * implementation behind every `performance.eventLoopUtilization()`
 * consumer (`s200/load-shed`'s default ELU sensor, `s200/unit-metrics`'
 * snapshot and reset window). Internal plumbing, not a battery: nothing
 * exports it on its own package path.
 *
 * Reading is incremental, never sampled: each `read()` diffs the
 * current utilization against the baseline of the previous read
 * (creation starts the first window), so the number covers exactly the
 * time between reads and no background timer ever wakes the loop.
 * `rebase()` moves the baseline to now without producing a reading —
 * the fresh-window move `reset()` needs.
 *
 * @internal
 */

import { performance } from 'node:perf_hooks';

/**
 * Creates an ELU reader owning its own baseline, taken at creation.
 * `read()` returns the utilization accrued since the previous read
 * (clamped to 0..1); `rebase()` restarts that window at now. Neither
 * method captures `this` — the functions lift straight off the record
 * (`sensors.eventLoopUtilization ?? elu.read`) without binding.
 */
export function createEluReader(): { read(): number; rebase(): void } {
  let last = performance.eventLoopUtilization();
  return {
    read(): number {
      const current = performance.eventLoopUtilization();
      const delta = performance.eventLoopUtilization(current, last);
      last = current;
      // Node reports NaN when zero loop time elapsed between reads (an
      // idle unit scraped twice back-to-back): that is 0% busy, not NaN.
      return Number.isFinite(delta.utilization)
        ? Math.min(1, Math.max(0, delta.utilization))
        : 0;
    },
    rebase(): void {
      last = performance.eventLoopUtilization();
    },
  };
}
