/**
 * dev-tool-search — on-demand tool discovery and unlock, the tool-search
 * pattern for the anchored preset.
 *
 * The promoted phase keeps only a minimal resident set (shell + filesystem
 * tools + the discovery tools) instead of dumping the whole Standard catalog
 * at once. This plugin registers ONE small tool:
 *
 *  - `dev_tool_search` — search the FULL assembled catalog by keyword and
 *    return matching tool names with short descriptions; optionally unlock
 *    tools by exact name (array `toolNames`). Unlocked names are recorded as
 *    durable `tool/call` arguments, and tool-bootstrap.mjs's assemble filter
 *    exposes them from the next request on (resume-safe).
 *
 * The tool description is deliberately an INDEX of what the minimal resident
 * set cannot do: the model should reach for dev_tool_search the moment a task
 * needs internet, delegation, workflows, goals, images, background jobs, or
 * multi-agent coordination — not try to work around them with bash.
 *
 * FIX (local + upstream): search matching was AND-over-all-tokens, so a long
 * natural query ("file edit write replace script root permissions") matched
 * NOTHING even against the full catalog. Now the query is split on
 * spaces/punctuation and every token matches independently (union, not AND);
 * exact tool-name matches rank first, then tools with more token hits. A
 * descriptive query may return a broad list, which is intentional — but an
 * EMPTY result is treated as a wrong query style: the tool tells the model to
 * stop sending descriptions and unlock by exact `toolNames` instead.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dev-tool-search'

/** The tools registry must exist before this tool can register. */
export const inject = ['tools']

const MAX_RESULTS = 25

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * The capability index: the resident minimal tools (shell / filesystem /
 * skill discovery) cannot cover these, so the model must search and unlock
 * them on demand. Kept in the description so the model KNOWS what exists
 * without a full catalog dump.
 */
const UNLOCKABLE_INDEX = [
  'web_search — internet search and web retrieval',
  'subagent / subagent_fork / list_agents — delegate work to sub-agents, inspect them, and choose their LLM',
  'workflow — run multi-agent workflow scripts',
  'ralph — fresh-agent iterative loop',
  'create_goal / get_goal / update_goal — long-running goals',
  'read / write / edit / glob / grep — file viewing, creation, modification, and search',
  'read_image — read image files',
  'job_list / job_output / job_kill — background jobs',
  'interrupt_agent / send_message — multi-agent control',
  'todo_write — task tracking',
  'ask_user_question — ask the user',
]

/** Register the model-facing `dev_tool_search` tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Discover and unlock tools that are NOT currently available.',
      '',
      'This session may start with a minimal resident set; everything else is unlocked on demand through this tool.',
      '',
      'If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:',
      ...UNLOCKABLE_INDEX.map((line) => `- ${line}`),
      '',
      'Usage: pass `query` to search the catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them. Unlocked tools appear from the next request on and stay unlocked for the session.',
      '',
      'Query behavior: the query is split on spaces/punctuation and each word is matched independently (union, not AND). "edit the file text" searches edit, the, file, and text, so it may return many results; exact tool-name matches rank first.',
      'Prefer the exact tool name, or 1-3 distinctive keywords. Do NOT use a descriptive sentence as your only search strategy.',
      '',
      'Example: dev_tool_search({"query":"web","toolNames":["web_search"]}) — search AND unlock in one call.',
      'IMPORTANT: an empty search result means no keyword matched at all — usually because the query was a description, not a tool name. Do not retry descriptive searches; pick the exact tool name from the index above and unlock it directly: dev_tool_search({"toolNames":["web_search"]}).',
      '',
      'Unlock EVERYTHING you need in ONE call (batch all names into a single `toolNames` array): every catalog change breaks the prompt prefix cache, so five separate unlock calls cost five cache rebuilds while one batched call costs one.',
      'Note: unlocks RESET when the session compacts (the catalog re-narrows after each compaction boundary). If a tool you unlocked has disappeared, unlock it again for the current epoch.',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: 'search keywords; spaces are split into independent tokens, exact tool names rank first (e.g. "web", "subagent", "edit file text")' },
      toolNames: { type: 'array', required: false, description: 'exact tool names to unlock', items: { type: 'string' } },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const unlock = Array.isArray(args.toolNames) ? args.toolNames.filter((name) => typeof name === 'string' && name.length > 0) : []

      const lines = []
      if (unlock.length > 0) {
        lines.push(`Unlocked for the next request: ${unlock.join(', ')}`)
      }
      if (query.length === 0 && unlock.length === 0) {
        lines.push('Provide `query` to search the catalog, or `toolNames` to unlock tools.')
        return { text: lines.join('\n') }
      }
      if (query.length === 0) {
        return { text: lines.join('\n') || 'Nothing to do.' }
      }

      try {
        // The executing agent IS the viewing scope: preset tools register into
        // the agent-scope layer of the tools registry, and schemas() with no
        // scope only sees the global layer — every preset-provided tool would
        // be invisible to keyword search (issue #24). Same pattern as the
        // harness's own code mode (`registry.schemas(exec.agent)`).
        const schemas = ctx.tools.schemas(exec?.agent)
        const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
        // Space-separated queries are intentional: each token matches
        // independently (union, not AND), so "edit the file text" searches
        // edit + the + file + text. A non-ASCII query has no ASCII tokens, so
        // keep it as one raw token instead of silently returning nothing.
        const wanted = tokens.length > 0 ? [...new Set(tokens)] : [query.toLowerCase()]
        // Score instead of AND-filter: exact tool-name matches rank first,
        // then tools matching more tokens. A descriptive query may return a
        // broad list; that is acceptable and better than an empty catalog.
        const scored = schemas
          .map((schema) => {
            const haystack = `${schema.name} ${schema.description ?? ''}`.toLowerCase()
            let score = 0
            for (const token of wanted) if (haystack.includes(token)) score += 1
            return {
              schema,
              score,
              exact: wanted.includes(schema.name.toLowerCase()),
            }
          })
          .filter((entry) => entry.exact || entry.score >= 1)
          .sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || a.schema.name.localeCompare(b.schema.name))
        const matches = scored.slice(0, MAX_RESULTS)
        if (matches.length === 0) {
          lines.push(
            `No tools match "${query}". Search matches tool names/keywords token-by-token; an empty result usually means this was a descriptive sentence, not a tool name. Do not keep issuing descriptive searches — switch to the exact tool name from the index above and unlock it directly: dev_tool_search({"toolNames":["web_search"]}).`,
          )
        } else {
          lines.push(`Matching tools (${matches.length}${scored.length > MAX_RESULTS ? ` of ${scored.length}` : ''}):`)
          for (const { schema, exact, score } of matches) {
            const desc = (schema.description || '').split('\n')[0].slice(0, 90)
            lines.push(`- ${schema.name}${exact ? ' (exact)' : ''}: ${desc}`)
          }
          if (scored.length > MAX_RESULTS) {
            lines.push(`(showing the top ${MAX_RESULTS} by token-hit count; pass exact toolNames if the tool name is already known)`)
          }
          lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
        }
      } catch (error) {
        lines.push(`catalog search unavailable: ${String((error && error.message) || error)}`)
      }
      return { text: lines.join('\n') }
    },
  })
}
