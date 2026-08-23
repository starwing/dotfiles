/**
 * miraculous-bootstrap — unified two-stage anchored bootstrap for DeepSeek V4 Pro
 * and V4 Flash, on BOTH the official DeepSeek API and the opencode-go
 * subscription endpoint. Path selection keys on the routed model id
 * (/flash/i), never on the provider — the official-API Flash is covered by
 * the same Flash path, and its behavioral evidence (persona-dominated,
 * catalog-immune, w7 optimum, P10 convergence binding) was in fact measured
 * on the official API.
 *
 * Forked from xiaobright/dsh-anchored-standard's tool-bootstrap.mjs (MIT),
 * extended with model-aware branching and an rc.6-safe promotion tracker.
 *
 * WHAT IT DOES
 * ------------
 * Request #1 (bootstrap phase):
 *   - exposes exactly the OFFICIAL Minimal preset's real tool pair —
 *     `bash` + `str_replace_editor` (issue #11: this schema anchors 5/5 at
 *     the adapter-default maxTokens=256000; every standard-family schema —
 *     pwsh/read, pwsh alone, sandbox bash/read — went standard-like 11/11);
 *   - strips the two automatic context injections Standard adds over Minimal
 *     (AGENTS.md/CLAUDE.md digest and the available-skills catalog — with
 *     them present the anchor reproduced 0/9, without ~81%);
 *   - optional first-request output cap (`bootstrapMaxTokens`, opt-in —
 *     the 1024 cap anchors 26/32 but its delivery is profile-package
 *     dependent, so the schema lever is the default).
 *
 * After the first durable promotion signal (default `promoteOn: either` —
 * first `tool/call` OR first `assistant/message`, whichever comes first):
 *   - PRO path (model id does NOT match /flash/i): the catalog narrows to a
 *     RESIDENT set — bootstrap pair + discovery tools (dev_tool_search /
 *     skill_search / skill_load) + tools explicitly unlocked via
 *     dev_tool_search. Dumping the full Standard catalog at promotion pulls
 *     the trajectory back to standard-like (the post-promotion regression);
 *     heavy tools stay one dev_tool_search call away.
 *   - FLASH path (model id matches /flash/i): Flash is persona-dominated and
 *     catalog-immune (full 21-tool catalog still anchored minimal-like in
 *     the A2/B-matrix; ability is flat at ~92 across harnesses). The persona
 *     section is replaced by the god-mode persona (router-standard w7 +
 *     deep anchor + the P10 convergence binding) on EVERY request, and the
 *     promoted catalog is the full Standard set (configurable to `resident`).
 *
 * COMPACTION: a compaction rewrites the model-visible surface, so the first
 * post-compaction request is a "second first request". Promotion is
 * epoch-aware: after `compaction/end` the session falls back to the
 * bootstrap pair + `compactionTools` until a NEW durable promotion signal
 * exists past that boundary.
 *
 * RC.6-SAFETY FIX (vs upstream): upstream memoizes a cold scan of the
 * durable event log and only advances it through `session/event`. On dsh
 * rc.6 the session/event feed is session-scoped and agent-plane presets may
 * never receive it — the memo then pins the session in whatever phase the
 * first scan saw (bootstrap forever, or — after promotion — blind to later
 * compaction boundaries). This tracker re-scans whenever the durable log
 * has grown since the memo was taken, so both promotion AND the
 * post-compaction demotion stay correct with or without the live feed.
 *
 * ROBUSTNESS (inherited discipline):
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of bricking the session.
 *  - The pre-step context filter degrades to "keep everything" on failure:
 *    a filter bug must never eat the user's context.
 *  - No synthetic messages are ever injected (the myDshPresets missing-id
 *    incident corrupted session histories); no extra model calls (the
 *    zero-tool/whoami anchors cost +1 call per session AND lose the
 *    trajectory once tools appear — measured on opencode-go).
 *  - Invalid config fails at preset mount, where it is visible and fixable.
 */

export const name = 'miraculous-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Registering without an inject — combined with this row being FIRST
 * in agent.cordis.yml and the `prepend` flags below — keeps the bootstrap
 * strip the OUTERMOST waterfall transform, so the first-request strip
 * actually removes what dsh-agent-instructions / dsh-tool-skill inject.
 */
export const inject = []

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'bootstrapTools',
  'promoteOn',
  'bootstrapMaxTokens',
  'suppressedContextSources',
  'compactionTools',
  'residentTools',
  'forcePath',
  'flashGuidance',
  'flashPersona',
  'flashPromotedCatalog',
  'includeSubagents',
  'proDisciplineHint',
  'proDisciplineHintText',
])

/**
 * Context sources stripped from the first request by default: the two
 * automatic `agent/pre-step` injections Standard adds over Minimal —
 * the available-skills reminder (`skill-catalog`) and the AGENTS.md/CLAUDE.md
 * workspace digest (`agent-instructions`).
 */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** The official Minimal preset's exact tool pair (issue #11 anchor). */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** Discovery tools always resident after promotion (the tool-search pattern). */
/**
 * Default post-promotion resident catalog for the Pro path (and for Flash
 * when `flashPromotedCatalog: resident`). Kept at the community-validated
 * 5-tool surface by default; operators may extend it with `read`, `grep`,
 * `edit`, `glob`, etc. via `residentTools`.
 */
const DEFAULT_RESIDENT_TOOLS = ['bash', 'dev_tool_search', 'skill_search', 'skill_load']

/**
 * Default Flash god-mode persona (SheberDavid's WEAK_FLASH, verbatim).
 * Composition, per the router-standard measurements:
 *  - w7: neutral persona + explicit classify-then-act instruction (Flash
 *    discrimination +5.67, P11) — spec-sentence personas ANTI-route Flash;
 *  - review / anti-runaway anchors: lift single-task completion 0% → 100%
 *    (P23);
 *  - deep-thinking sentence WITH the P10 convergence binding ("Produce when
 *    your information is complete...") — pure "think deeply" instructions
 *    run to the budget ceiling with 0% convergence (P10: deep1/deep2);
 *    react + deep-then-produce doubles reasoning depth at 100% convergence.
 * Caveat (P21): on tightly RELATED task chains, static guidance measured
 * NEGATIVE (46-63% vs 63% baseline) — set `flashGuidance: false` for those
 * workloads.
 */
const DEFAULT_FLASH_PERSONA =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply about the architecture, edge cases, and integration points before writing. Do not spend reasoning on the environment or tooling. Produce when your information is complete, and end each reasoning block with a decision or an information need.'

/**
 * Epoch-aware promotion tracking lives in ./compaction-epoch.mjs (shared
 * with instruction-hint). v1.2.0: the inline copy was removed so the rc.6
 * growth-rescan fix exists in exactly ONE place — the two trackers had
 * diverged, leaving instruction-hint on the stale upstream logic.
 */
import { createEpochPromotion } from './compaction-epoch.mjs'

/** True when the routed model id is a Flash-family model. */
function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/**
 * Opt-in Pro long-task discipline hint (default OFF). Injected ONCE per
 * session, only AFTER promotion, on the Pro path — the first-request anchor
 * is untouched, and post-promotion one-shot hints do not perturb the
 * trajectory (the 98/99 runs carried restored post-promotion context
 * throughout). Targets the measured runaway pattern (modeltest harness
 * analysis, 4th formal OpenCode run: ~400k context peak, five full rebuilds,
 * repeated environment reverse-engineering, no stop conditions). Kept
 * opt-in because persona-level guidance text has measured downside on Pro
 * (P24) — this is a single user-role hint, not a persona change.
 */
const DEFAULT_PRO_DISCIPLINE_HINT =
  'Long-task discipline for this session: set explicit stop conditions before exploring; '
  + 'never re-run a command that failed unchanged — change one variable at a time; '
  + 'verify each edit incrementally with the smallest possible check instead of full rebuilds; '
  + 're-read the relevant file when context feels stale rather than repeating searches; '
  + 'keep a running tally of remaining budget and say so when a verification step is expensive.'

/**
 * Replace ONLY the persona section of an assembled section list, keeping
 * everything else — the plan-mode section above all (router-standard §G:
 * an early router replaced the whole section list, dropped the plan-mode
 * section, and the model lost the plan boundary → repeated searches).
 */
function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'miraculous-persona', text: personaText, order: 0 }]
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. An explicitly empty array is
 * meaningful: it disables the context filter while keeping the tool bootstrap.
 */
function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (a prebuilt rc.6-reporting
 * profile was observed overwriting it with `adapterDefaults.maxTokens`).
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

function parseForcePath(value) {
  if (value === undefined || value === 'auto') return 'auto'
  if (value === 'pro' || value === 'flash') return value
  throw new TypeError(`${name}: forcePath must be one of "auto", "pro", "flash"; got ${JSON.stringify(value)}`)
}

function parseFlashPromotedCatalog(value) {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'resident') return value
  throw new TypeError(`${name}: flashPromotedCatalog must be "full" or "resident"; got ${JSON.stringify(value)}`)
}

function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name}: ${field} must be a boolean`)
  }
  return value
}

function optionalNonEmptyString(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name}: ${field} must be a non-empty string`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
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
  const bootstrapTools = source.bootstrapTools === undefined
    ? [...DEFAULT_BOOTSTRAP_TOOLS]
    : stringList(source.bootstrapTools, 'bootstrapTools')
  const residentTools = source.residentTools === undefined
    ? [...DEFAULT_RESIDENT_TOOLS]
    : stringList(source.residentTools, 'residentTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  // Core work set exposed after a compaction, before re-promotion.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')

  // Model-aware branching.
  const forcePath = parseForcePath(source.forcePath)
  const flashGuidance = optionalBoolean(source.flashGuidance, 'flashGuidance', true)
  const flashPersona = optionalNonEmptyString(source.flashPersona, 'flashPersona', DEFAULT_FLASH_PERSONA)
  const flashPromotedCatalog = parseFlashPromotedCatalog(source.flashPromotedCatalog)
  const includeSubagents = optionalBoolean(source.includeSubagents, 'includeSubagents', true)
  const proDisciplineHint = optionalBoolean(source.proDisciplineHint, 'proDisciplineHint', false)
  const proDisciplineHintText = optionalNonEmptyString(source.proDisciplineHintText, 'proDisciplineHintText', DEFAULT_PRO_DISCIPLINE_HINT)

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

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
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. EPOCH-AWARE (v1.1.0): only unlocks recorded AFTER the last
   * `compaction/end` boundary count. Without this, a long session's unlock
   * set grows monotonically across compactions — and the measured tool-count
   * threshold (local trigger notes: +4 extra tools starts surfacing `let
   * me`, +8 fully wakes the standard-like persona) means an ever-growing
   * resident catalog is exactly how long conversations drift. The
   * post-compaction resident set re-narrows to the bootstrap pair +
   * discovery tools; the model re-unlocks only what the current epoch needs.
   */
  const unlockedFor = (session, boundary) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      const seq = event.seq ?? 0 // seq-less events are treated as post-boundary
      if (boundary >= 0 && seq <= boundary) continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const toolName of names) if (typeof toolName === 'string' && toolName.length > 0) unlocked.add(toolName)
    }
    return unlocked
  }

  /** Narrow the assembled catalog to a keep-set; validate required names. */
  const keepTools = (assembled, keep, missingAllowsFullCatalog) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const agent = context.agent
      const modelId = agent?.options?.model
      const path = forcePath !== 'auto' ? forcePath : (isFlashModel(modelId) ? 'flash' : 'pro')

      // Flash: god-mode persona on EVERY request (persona-led model — the
      // catalog is not its trigger). applyPersona touches ONLY the persona
      // section; plan-mode and every other section survive (router §G fix).
      const sections = (path === 'flash' && flashGuidance)
        ? applyPersona(assembled.sections, flashPersona)
        : assembled.sections
      const withSections = sections === assembled.sections ? assembled : { ...assembled, sections }

      const status = promotion.status(agent)
      if (status.promoted) {
        // FLASH promoted: full Standard catalog (default) — Flash is
        // catalog-immune (A2/B-matrix); `resident` keeps the narrow set.
        if (path === 'flash' && flashPromotedCatalog === 'full') return withSections
        // PRO promoted (or Flash in resident mode): minimal resident set —
        // bootstrap pair + discovery tools + explicitly unlocked tools —
        // never a full Standard dump (the post-promotion regression fix).
        const keep = new Set([...residentTools, ...unlockedFor(agent?.session, status.boundary)])
        return keepTools(withSections, keep, false)
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return keepTools(withSections, keep, true)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset means the adapter default flows — the Minimal tool schema anchors
  // at 256000 without a cap (issue #11). `prepend` keeps this listener the
  // OUTERMOST transform of the agent/request waterfall so a later listener
  // can never override the first-round budget after we set it.
  if (bootstrapMaxTokens !== undefined) {
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // Strip first-step injected reminders (skill catalog, AGENTS.md digest)
  // during bootstrap. First-registered + `prepend` keeps this strip the
  // final waterfall transform, so it actually removes what later listeners
  // inject (issue #6).
  const disciplineHinted = new Set() // `${sessionId}:${epochBoundary}` keys
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const status = promotion.status(agent)
      if (status.promoted) {
        // Opt-in Pro long-task discipline hint: once PER EPOCH, only after
        // promotion (the anchor window is long closed), Pro path only.
        // Per-epoch because a compaction folds the earlier hint into the
        // summary — the post-compaction epoch would otherwise run without it.
        if (!proDisciplineHint) return decision
        const path = forcePath !== 'auto' ? forcePath : (isFlashModel(agent?.options?.model) ? 'flash' : 'pro')
        if (path !== 'pro') return decision
        const sid = agent?.session?.id
        const epochKey = `${sid}:${status.boundary}`
        if (sid === undefined || disciplineHinted.has(epochKey) || !Array.isArray(decision.messages)) return decision
        disciplineHinted.add(epochKey)
        return {
          ...decision,
          messages: [...decision.messages, {
            id: `miraculous-discipline-hint-${sid}-${status.boundary}`,
            role: 'user',
            content: [{ type: 'text', text: proDisciplineHintText }],
            source: { kind: 'miraculous-discipline-hint', form: 'hint' },
          }],
        }
      }
      if (suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
