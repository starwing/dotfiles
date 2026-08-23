/**
 * Epoch-aware promotion tracker shared by the bootstrap and baseline-gate
 * plugins of the anchored presets.
 *
 * A compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message, and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
 *
 * State is memoized per session id and maintained incrementally through
 * `observe()`; a cold session scans its durable log once (so resume and
 * reload reconstruct the same phase).
 *
 * RC.6-SAFETY (v1.2.0): on dsh rc.6 the `session/event` feed is
 * session-scoped and agent-plane presets may never receive it. Upstream's
 * memo then pins the session in whatever phase the first scan saw —
 * bootstrap forever when unpromoted, and blind to later compaction
 * boundaries once promoted. `status()` therefore re-scans whenever the
 * durable log has grown since the memo was taken, so BOTH the initial
 * promotion and the post-compaction demotion stay correct with or without
 * the live feed. With a live feed, `observe()` keeps `scanned` in sync and
 * no re-scan happens.
 *
 * By default subagents (`delegationDepth > 0`) are treated as already
 * promoted so their first request can use tools. Set `includeSubagents: true`
 * to make subagents follow the same bootstrap/anchor phase as top-level
 * sessions.
 */

/** Build one epoch-aware promotion tracker. */
export function createEpochPromotion(promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const promote = new Set(promoteEvents)
  /** sessionId -> { boundary, promoted, scanned } */
  const state = new Map()

  /** Scan a session's durable log from scratch (cold start / resume / staleness). */
  const scan = (session) => {
    let boundary = -1
    let promoted = false
    for (const event of session.events) {
      const seq = event.seq ?? 0 // events without a seq are treated as post-boundary
      if (event.type === 'compaction/end') {
        boundary = seq
        promoted = false
        continue
      }
      if (promote.has(event.type) && seq > boundary) promoted = true
    }
    const entry = { boundary, promoted, scanned: session.events.length }
    state.set(session.id, entry)
    return entry
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted } — `boundary` is the last compaction/end
     *   seq (-1 before any compaction); `promoted` is true when a durable
     *   promotion signal exists after that boundary.
     */
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true }
      // By default subagents keep the full catalog from their very first
      // request; includeSubagents makes them follow the normal bootstrap phase.
      if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      const entry = state.get(session.id)
      // rc.6-safe: re-scan whenever the durable log grew since the memo was
      // taken — whether or not the session has promoted. Without the live
      // feed, a post-promotion compaction/end would otherwise stay invisible
      // forever, and the session would never re-anchor.
      if (entry !== undefined && session.events.length === entry.scanned) return entry
      return scan(session)
    },
    /** Incremental feed: call on every `session/event` (when the feed exists). */
    observe(session, event) {
      const entry = state.get(session.id)
      if (entry === undefined) return
      entry.scanned += 1
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        state.set(session.id, { boundary: seq, promoted: false, scanned: entry.scanned })
        return
      }
      if (promote.has(event.type) && seq > entry.boundary && !entry.promoted) {
        state.set(session.id, { ...entry, promoted: true })
      }
    },
  }
}
