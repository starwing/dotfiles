/**
 * instruction-hint — replace `dsh-agent-instructions`' full AGENTS.md/CLAUDE.md
 * injection with a minimal, non-imperative "these files exist" hint.
 *
 * WHY: the full workspace-instruction digest is a large injected block. After
 * the anchored bootstrap promotes, we want the model to KNOW the instruction
 * files exist without dumping their content into every request. Community
 * measurement (xiaobright/dsh-anchored-standard issue #49) showed that an
 * imperative hint ("read first and follow them") can flip an anchored
 * trajectory back to "let me"; a neutral reference note preserves the
 * anchored trajectory while the model still reads files on demand.
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
 *  - The hint is declarative and recommends, not commands: files are
 *    reference documents about the environment, not task instructions.
 *  - Files are probed via `ctx.fs`; a missing fs or unreadable probe
 *    degrades to no hint (never throws).
 *  - Pre-promotion requests get NO hint (matches the anchored bootstrap).
 *  - Subagents follow the same phase when `includeSubagents: true`.
 *
 * ROW ORDER: this plugin registers its `agent/pre-step` handler with
 * `prepend: true` and after `miraculous-bootstrap`, so it runs inside the
 * bootstrap's outermost strip — but it emits AFTER promotion, when the strip
 * is inactive. The hint source kind is `instruction-hint`, which is not in
 * `suppressedContextSources`, so it is never stripped.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'instruction-hint'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['promoteOn', 'includeSubagents'])

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

  /** True when a durable user/message for this epoch already carries the hint. */
  const hintIsDurable = (session, boundary) => {
    const idMarker = `instruction-hint-${session.id}-${boundary}`
    return (Array.isArray(session.events) ? session.events : []).some((event) => {
      if (event.type !== 'user/message') return false
      const data = event.data
      if (data?.source?.kind !== 'instruction-hint') return false
      return typeof data?.id === 'string'
        ? data.id === idMarker || data.id.includes(`-${boundary}`)
        : true
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
      if (fs === undefined) return decision
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

      const sections = []
      if (projectFiles.length > 0) {
        sections.push(`Workspace instruction files exist: ${[...new Set(projectFiles)].join(', ')} (project root: ${root}).`)
      }
      if (userGlobalFiles.length > 0) {
        sections.push(`A user-global instruction file exists: ${userGlobalFiles.join(', ')}.`)
      }
      // Mark the epoch AFTER a successful probe (empty result included). On
      // probe failure we do NOT mark, so the next step retries.
      hinted.add(epochKey)
      if (sections.length === 0) return decision

      const text = [
        ...sections,
        'They are reference documents about the workspace and user environment (paths, network rules, tooling notes), not task instructions. Reading the relevant file before workspace tasks is recommended — it is short — but consult them only when you need environment details; the task itself never depends on them.',
      ].join(' ')

      return {
        ...decision,
        messages: [...decision.messages, {
          id: `instruction-hint-${session.id}-${status.boundary}`,
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
