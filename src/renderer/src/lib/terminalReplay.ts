/**
 * A dependency-free replay gate that eliminates the disconnect gap when a
 * terminal reconnects to a still-live Core — and prevents the duplicate
 * output a naive snapshot round-trip produces.
 *
 * Subscribe to live PTY output BEFORE requesting a snapshot. Route each live
 * chunk through `pushLive(chunk, generation)`, where `generation` is the
 * monotonic chunk count the Core assigned when it appended the chunk to its
 * replay buffer. While the snapshot is in flight the gate queues them.
 *
 * When the snapshot arrives, call
 * `completeSnapshot(buffer, snapshotGeneration)`: it returns the snapshot
 * buffer followed by every queued chunk whose generation is GREATER than
 * `snapshotGeneration` — those landed after the snapshot was captured, so they
 * are not in the buffer. Chunks covered by the snapshot
 * (`generation <= snapshotGeneration`) are dropped: they are already in the
 * buffer, and emitting them again would duplicate output. The gate is then
 * hydrated, and subsequent live chunks flow straight through to `onChunk`.
 *
 * On snapshot failure or a null snapshot, call `completeSnapshot('', 0)`: an
 * empty buffer behind a zero fence flushes every queued chunk (all generations
 * are > 0) without fabricating history, so a missing snapshot never deadlocks
 * or loses live output.
 */
export type ReplayGate = {
  /**
   * Before hydration: queue the chunk with its generation. After: deliver
   * immediately via `onChunk`. A chunk with no generation is treated as
   * uncovered (always flushed) so a legacy caller can never silently drop data.
   */
  pushLive: (chunk: string, generation?: number) => void
  /**
   * Return the snapshot buffer followed by the queued chunks NOT covered by it
   * (generation > snapshotGeneration). Idempotent: a second call returns an
   * empty array and never replays the snapshot again.
   */
  completeSnapshot: (buffer: string, snapshotGeneration: number) => string[]
  /** True once `completeSnapshot` has been called. */
  isHydrated: () => boolean
}

export function createReplayGate(onChunk: (chunk: string) => void): ReplayGate {
  const pending: Array<{ chunk: string; generation?: number }> = []
  let hydrated = false

  return {
    pushLive(chunk: string, generation?: number) {
      if (hydrated) {
        onChunk(chunk)
      } else {
        pending.push({ chunk, generation })
      }
    },
    completeSnapshot(buffer: string, snapshotGeneration: number): string[] {
      if (hydrated) return []
      hydrated = true
      // Keep only chunks the snapshot cannot already contain: those with a
      // generation strictly greater than the snapshot's. A chunk with no
      // generation is kept too (defensive — never drop unknown data).
      const after = pending.filter(
        (p) => p.generation == null || p.generation > snapshotGeneration
      )
      pending.length = 0
      return [buffer, ...after.map((p) => p.chunk)]
    },
    isHydrated() {
      return hydrated
    }
  }
}
