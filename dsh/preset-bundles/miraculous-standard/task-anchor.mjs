/**
 * task-anchor — put the durable task anchor back into context after compaction.
 *
 * WHY: a long unattended session can survive several compactions, and each
 * summary is allowed to drop details. A plan file on disk does not help if the
 * model forgets to read it. This plugin does not rely on the model reading
 * anything: after the first `compaction/end` in a session, it reads a local
 * anchor file and injects its content as one durable user message. The message
 * carries the `task-anchor` source kind, so a context gate can allow it through
 * even while the post-compaction session is unpromoted.
 *
 * Behavior:
 *  - Only runs after a compaction boundary (`boundary >= 0`). Fresh sessions
 *    and short sessions are untouched, so the first-request anchor is safe.
 *  - Injects at most once per compaction epoch (`session.id + boundary`).
 *  - Resolves `anchorFile` (default `AGENTS.local.md`) first in the session
 *    cwd, then at the project root (the nearest ancestor with a project
 *    marker such as `.git`), then from `$DSH_HOME`, then from `$HOME`.
 *    If no file is found, it skips silently.
 *  - Bounds the injected content with `anchorMaxBytes`.
 *  - Skips subagents by default; set `includeSubagents: true` if a long-lived
 *    child also needs the anchor.
 *
 * ROW ORDER: register this row after `instruction-hint`. The handler uses the
 * `agent/pre-step` waterfall with `prepend: true`, like `instruction-hint`, and
 * emits only after a compaction boundary has been observed.
 */

import { randomUUID } from 'node:crypto'
import { createEpochPromotion, sessionEvents } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'task-anchor'

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['anchorFile', 'anchorMaxBytes', 'includeSubagents'])

const DEFAULT_ANCHOR_FILE = 'AGENTS.local.md'
const DEFAULT_ANCHOR_MAX_BYTES = 16384

function booleanOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name}: ${field} must be a boolean`)
  }
  return value
}

function nonEmptyStringOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name}: ${field} must be a non-empty string`)
  }
  return value
}

function positiveIntOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** Join one path segment onto a directory (platform-agnostic string join). */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/** All ancestor directories from cwd upward (cwd first, root last). */
function ancestorDirs(cwd) {
  const dirs = []
  let current = cwd
  for (;;) {
    dirs.push(current)
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return dirs
    current = parent
  }
}

/** Find the project root: first ancestor containing any root marker. */
async function findProjectRoot(fs, cwd, signal) {
  for (const dir of ancestorDirs(cwd)) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(dir, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return dir
      } catch {
        // Probe failure = marker absent; continue.
      }
    }
  }
  return cwd
}

/** Return the readable target for one candidate path, or undefined. */
async function presentFileTarget(fs, path, cwd, signal) {
  try {
    const target = await fs.resolve(path, { cwd, signal })
    const info = await fs.stat(target, signal)
    return info !== undefined && info.type === 'file' ? target : undefined
  } catch {
    return undefined
  }
}

/** Resolve and read the anchor file, bounded to the configured budget. */
async function readAnchorFile(fs, cwd, anchorFile, maxBytes, signal) {
  const pathLike = anchorFile.includes('/') || anchorFile.includes('\\')
  const candidates = []

  if (pathLike) {
    candidates.push({ path: anchorFile, cwd })
  } else {
    // Prefer the session's own directory, then the DSH project root (the
    // nearest ancestor carrying a project marker such as `.git`). The project
    // root is a dsh-agent-instructions convention, not a separate DSH service.
    candidates.push({ path: joinPath(cwd, anchorFile), cwd })
    const root = await findProjectRoot(fs, cwd, signal)
    if (root !== cwd) candidates.push({ path: joinPath(root, anchorFile), cwd: root })
    const dshHome = process.env.DSH_HOME ?? (process.env.HOME ? `${process.env.HOME}/.dsh` : undefined)
    if (dshHome !== undefined) candidates.push({ path: joinPath(dshHome, anchorFile), cwd: dshHome })
    if (process.env.HOME !== undefined && process.env.HOME.length > 0) {
      candidates.push({ path: joinPath(process.env.HOME, anchorFile), cwd: process.env.HOME })
    }
  }

  for (const candidate of candidates) {
    const target = await presentFileTarget(fs, candidate.path, candidate.cwd, signal)
    if (target === undefined) continue
    let text = await fs.readText(target, signal)
    if (text.length > maxBytes) {
      text = `${text.slice(0, maxBytes)}\n\n[task-anchor truncated at ${maxBytes} characters]`
    }
    return { text, displayPath: target.displayPath }
  }
  return undefined
}

/** Register the post-compaction task-anchor injector. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }

  const anchorFile = nonEmptyStringOption(source.anchorFile, 'anchorFile', DEFAULT_ANCHOR_FILE)
  const anchorMaxBytes = positiveIntOption(source.anchorMaxBytes, 'anchorMaxBytes', DEFAULT_ANCHOR_MAX_BYTES)
  const includeSubagents = booleanOption(source.includeSubagents, 'includeSubagents', false)

  // Empty promotion set: this plugin cares only about compaction boundaries.
  const promotion = createEpochPromotion([], { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  const injected = new Set()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  const anchorIdPrefix = (session, boundary) => `task-anchor-${session.id}-${boundary}-`

  /** True when a durable user/message for this epoch already carries the anchor. */
  const anchorIsDurable = (session, boundary) => {
    const prefix = anchorIdPrefix(session, boundary)
    return sessionEvents(session).some((event) => {
      if (event.type !== 'user/message') return false
      const data = event.data
      if (data?.source?.kind !== 'task-anchor') return false
      return typeof data.id === 'string' && data.id.startsWith(prefix)
    })
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      const status = promotion.status(agent)
      if (status.boundary < 0) return decision

      const session = agent.session
      if (session === undefined) return decision
      const epochKey = `${session.id}:${status.boundary}`
      if (injected.has(epochKey) || anchorIsDurable(session, status.boundary)) return decision

      const fs = ctx.get('fs')
      if (fs === undefined || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function' || typeof fs.readText !== 'function') {
        return decision
      }

      const cwd = session.header.cwd ?? process.cwd()
      const anchor = await readAnchorFile(fs, cwd, anchorFile, anchorMaxBytes, signal)
      // Mark the epoch after a completed probe, found or not, so a missing
      // anchor file is not re-read on every step of the same epoch.
      injected.add(epochKey)
      if (anchor === undefined || anchor.text.trim().length === 0) return decision

      const text = `<task_anchor>\n${anchor.text.trim()}\n</task_anchor>`

      return {
        ...decision,
        messages: [...decision.messages, {
          id: `${anchorIdPrefix(session, status.boundary)}${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'task-anchor', form: 'mission-card', path: anchor.displayPath },
        }],
      }
    } catch (error) {
      // A task-anchor bug must never hurt the session: skip the injection.
      warnOnce(`${name}: anchor injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
