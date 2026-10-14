/**
 * instruction-hint — replace `dsh-agent-instructions`' full AGENTS.md/CLAUDE.md
 * injection with a one-shot "read these files before acting" requirement, and
 * carry the post-promotion tool-catalog reminder in the SAME message.
 *
 * WHY: the full workspace-instruction digest is a large injected block. After
 * the anchored bootstrap promotes, this row lists the instruction files it
 * found and REQUIRES reading them before doing anything else, without dumping
 * their content into the request. NOTE: the earlier upstream design
 * deliberately used a neutral reference note because community measurement
 * (xiaobright/dsh-anchored-standard issue #49) showed an imperative hint
 * ("read first and follow them") could flip an anchored trajectory back to
 * "let me". This preset makes the requirement imperative by request; the
 * catalog reminder travels in the same message so promotion adds only one
 * user message.
 *
 * Behavior:
 *  - After the session records its first durable promotion signal
 *    (`promoteOn`, default `either`), ONE hint message is injected per EPOCH
 *    (durable event scan, resume-safe; re-injected after each compaction
 *    because the summary folds the earlier hint away).
 *  - It lists which instruction files were found:
 *      - user-global: `$DSH_HOME/AGENTS.md`
 *      - project chain: AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md
 *        walking from the session cwd up to the project root (a directory
 *        containing `.git`, or the cwd itself).
 *  - The file section is imperative: read the listed file(s) before continuing
 *    and follow them.
 *  - When `catalogChangeHint` is true (default), the same user message also
 *    tells the model that promotion changed the function list and that it
 *    must re-read that list before claiming a tool is unavailable. Flash has
 *    been observed to keep insisting it only has the bootstrap pair and to
 *    end the turn without re-reading the expanded catalog.
 *  - Files are probed via `ctx.fs`; a missing fs degrades to the catalog
 *    section alone (never throws).
 *  - Pre-promotion requests get NO hint (matches the anchored bootstrap).
 *  - Subagents follow the same phase when `includeSubagents: true`.
 *
 * ROW ORDER: this plugin registers its `agent/pre-step` handler with
 * `prepend: true` and after `miraculous-bootstrap`, so it runs inside the
 * gate's outermost strip — but it emits AFTER promotion, when the strip is
 * inactive. The hint source kind is `instruction-hint`; the context gate does
 * not strip it once the session is promoted.
 */

import { randomUUID } from 'node:crypto'
import { createEpochPromotion, sessionEvents } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'instruction-hint'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['promoteOn', 'includeSubagents', 'catalogChangeHint', 'catalogChangeHintText'])

/**
 * Post-promotion tool-catalog reminder carried in the same message as the
 * instruction-file reference note (default ON). The two-phase bootstrap
 * exposes only the Minimal pair on request #1; the promoted request carries
 * the expanded schemas plus a developer tool-addition message, but Flash has
 * been observed to keep claiming it only has `bash` + `str_replace_editor`
 * and to end the turn without re-reading its function list.
 */
const DEFAULT_CATALOG_CHANGE_HINT =
  'Tool catalog update: this request uses the promoted catalog. Re-read the function list in this request before saying a tool is unavailable; the tool-registry update that follows lists what changed. If a tool you need is not listed, use dev_tool_search to unlock it.'

/** Candidate file names, in probe order, for the project chain and user-global. */
const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

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

/** Find the project root: first ancestor containing any root marker (e.g. .git). */
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

/** List instruction files present in one directory, returning display paths. */
async function presentInDirWithPath(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(target.displayPath)
    } catch {
      // Absent or unreadable — skip.
    }
  }
  return found
}

/** Register the post-promotion instruction-hint injector. */
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
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const includeSubagents = booleanOption(source.includeSubagents, 'includeSubagents', true)
  const catalogChangeHint = booleanOption(source.catalogChangeHint, 'catalogChangeHint', true)
  const catalogChangeHintText = nonEmptyStringOption(source.catalogChangeHintText, 'catalogChangeHintText', DEFAULT_CATALOG_CHANGE_HINT)
  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /**
   * Epochs that already received the hint in this process, keyed
   * `${sessionId}:${boundary}`. A durable-log scan backs this up so a process
   * restart cannot re-inject the same epoch hint (resume-safe).
   */
  const hinted = new Set()
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

  /**
   * Unique id prefix that ties one hint message to its session epoch. The
   * pre-randomUUID id (no trailing suffix) is still recognized for sessions
   * that already carry one, so upgrading does not inject a duplicate hint.
   */
  const hintIdPrefix = (session, boundary) => `instruction-hint-${session.id}-${boundary}-`
  const legacyHintId = (session, boundary) => `instruction-hint-${session.id}-${boundary}`

  /** True when a durable user/message for this epoch already carries the hint. */
  const hintIsDurable = (session, boundary) => {
    const prefix = hintIdPrefix(session, boundary)
    const legacy = legacyHintId(session, boundary)
    return sessionEvents(session).some((event) => {
      if (event.type !== 'user/message') return false
      const data = event.data
      if (data?.source?.kind !== 'instruction-hint') return false
      return typeof data?.id === 'string' && (data.id === legacy || data.id.startsWith(prefix))
    })
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      const status = promotion.status(agent)
      if (status.promoted !== true) return decision
      const session = agent.session
      if (session === undefined) return decision
      const epochKey = `${session.id}:${status.boundary}`
      if (hinted.has(epochKey) || hintIsDurable(session, status.boundary)) return decision

      const fs = ctx.get('fs')
      const fileSections = []
      if (fs !== undefined) {
        const cwd = session.header.cwd ?? process.cwd()

        const projectFiles = []
        const root = await findProjectRoot(fs, cwd, signal)
        for (const dir of ancestorDirs(cwd)) {
          // Stop once we pass the project root; the root itself is included.
          const found = await presentInDirWithPath(fs, dir, PROJECT_CANDIDATES, signal)
          projectFiles.push(...found)
          if (dir === root) break
        }

        const userGlobalFiles = []
        try {
          const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
          if (dshHome !== undefined) {
            userGlobalFiles.push(...await presentInDirWithPath(fs, dshHome, [USER_GLOBAL_CANDIDATE], signal))
          }
        } catch {
          // Unreadable home probe — ignore.
        }

        if (projectFiles.length > 0) {
          fileSections.push(`Workspace instruction files exist: ${[...new Set(projectFiles)].join(', ')} (project root: ${root}).`)
        }
        if (userGlobalFiles.length > 0) {
          fileSections.push(`A user-global instruction file exists: ${userGlobalFiles.join(', ')}.`)
        }
      }
      // Mark the epoch once the probe pass completed (or fs was unavailable).
      // On a thrown probe failure we do NOT mark, so the next step retries.
      hinted.add(epochKey)

      const parts = []
      if (fileSections.length > 0) {
        parts.push(...fileSections)
        parts.push('Read the instruction file(s) listed above before continuing — beginning with AGENTS.md when it is listed — and follow them. They are binding workspace instructions, not optional references.')
      }
      if (catalogChangeHint) parts.push(catalogChangeHintText)
      if (parts.length === 0) return decision

      const text = parts.join(' ')

      return {
        ...decision,
        messages: [...decision.messages, {
          id: `${hintIdPrefix(session, status.boundary)}${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'instruction-hint', form: 'hint' },
        }],
      }
    } catch (error) {
      // A hint bug must never hurt the session: skip the hint.
      warnOnce(`${name}: hint injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
