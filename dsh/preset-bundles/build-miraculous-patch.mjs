// Generates preset-bundles/miraculous-standard/cordis.patch.yml from the legacy
// $DSH_HOME/.agent-presets/miraculous-standard/ directory.
//
// Why: 0.1.7-rc.2 no longer scans .agent-presets/ (the registry "neither scans
// directories nor accepts preset paths"). A preset is now a declaration row
// carried by a bundle patch. This script converts the legacy pair
// (preset.yml + agent.cordis.yml) into that declaration, preserving the plugin
// list byte-for-byte (only the retired workflow engine row is updated).
//
// Run: node preset-bundles/build-miraculous-patch.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(homedir(), '.dsh', '.agent-presets', 'miraculous-standard')
const outFile = join(here, 'miraculous-standard', 'cordis.patch.yml')

// preset.yml is four plain scalars on one line each (no block scalars); read
// them positionally rather than pulling in a YAML dependency for a build script.
const presetYml = readFileSync(join(legacyDir, 'preset.yml'), 'utf8')
const scalar = (key) => {
  const match = presetYml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  if (!match) throw new Error(`preset.yml: no "${key}" field`)
  return match[1].trim()
}
const preset = {
  name: scalar('name'),
  description: scalar('description'),
  order: Number(scalar('order')),
}
if (!Number.isInteger(preset.order)) throw new Error('preset.yml: order is not an integer')

const rows = readFileSync(join(legacyDir, 'agent.cordis.yml'), 'utf8')

// ── the one semantic fix: the workflow engine package was retired ───────────
// `@deepseek-ai/dsh-workflow-worker-thread` does not exist in 0.1.7-rc.2.
// `@deepseek-ai/dsh-workflow-ptc` is its successor: it extends the same
// WorkflowEngine (`ctx.workflowEngine`) seam and its Config accepts the same
// `provider` field (default `spawn`), so the row carries over 1:1.
const OLD_ROW = [
  '    - id: workflow-worker-thread',
  "      name: '@deepseek-ai/dsh-workflow-worker-thread'",
].join('\n')
const NEW_ROW = [
  '    # MIGRATED: was `@deepseek-ai/dsh-workflow-worker-thread`, which no longer',
  '    # ships. `dsh-workflow-ptc` provides the same `workflowEngine` service and',
  '    # accepts the same `provider` field (default `spawn`).',
  '    - id: workflow-engine',
  "      name: '@deepseek-ai/dsh-workflow-ptc'",
].join('\n')

if (!rows.includes(OLD_ROW)) throw new Error('retired workflow row not found — legacy file changed?')
let patched = rows.replace(OLD_ROW, NEW_ROW)

// ── rewrite the relative `./*.mjs` row names to bundle subpaths ─────────────
// A preset row is imported through EntryTree.import, which resolves against the
// DECLARING row's baseUrl. For a declaration carried by a bundle patch that base
// is the profile configuration directory (/…/profiles/web/), NOT this bundle:
// the mount inherited `ctx.baseUrl` from the declaring Loader. So `./x.mjs`
// resolved to <profileDir>/x.mjs, the import failed, the entry never got a
// fiber, and the registry's audit rejected the whole mount with
// "<id> (./x.mjs): never started".
//
// The fix is the form every shipped preset uses: a bare package specifier,
// resolved from the profile directory through this bundle's pnpm link in
// profiles/<name>/node_modules. Subpaths are reachable because this bundle's
// package.json declares no "exports" map.
const bundlePkg = JSON.parse(readFileSync(join(here, 'miraculous-standard', 'package.json'), 'utf8')).name
let rewritten = 0
patched = patched.replace(/^(\s*name:[ \t]*)'?\.\/([\w.-]+\.mjs)'?[ \t]*$/gm, (_match, prefix, file) => {
  rewritten += 1
  return `${prefix}'${bundlePkg}/${file}'`
})
if (rewritten === 0) throw new Error('no relative ./x.mjs row names found — nothing to rewrite?')

// ── indent the whole legacy entry list under `config.plugins` ───────────────
// Verbatim beyond the two edits above: comments, `!!js` tags and block scalars
// all survive; only leading whitespace changes.
const indented = patched
  .replace(/\n+$/, '')
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : `          ${line}`))
  .join('\n')

const q = (value) => JSON.stringify(value) // JSON string escapes are valid YAML

const header = `# Bundle patch declaring the \`miraculous-standard\` agent preset.
#
# MIGRATED from the legacy preset directory \`$DSH_HOME/.agent-presets/miraculous-standard/\`
# (which held \`preset.yml\` + \`agent.cordis.yml\`). In 0.1.7-rc.2 the preset
# registry neither scans directories nor accepts preset paths: a preset is an
# ordinary declaration row of \`@deepseek-ai/dsh-agent-preset\`, carried by a
# bundle patch installed into the profile. The legacy directory is now inert.
#
# The plugin list below is the legacy \`agent.cordis.yml\` verbatim, with two
# changes:
#   1. \`@deepseek-ai/dsh-workflow-worker-thread\` (removed upstream) became
#      \`@deepseek-ai/dsh-workflow-ptc\`.
#   2. Every \`./x.mjs\` row name became \`${bundlePkg}/x.mjs\`.
#
# (2) is required, not cosmetic. A preset row is imported through
# \`EntryTree.import\`, which resolves a specifier against the DECLARING row's
# \`baseUrl\` — for a bundle-carried declaration that is the profile
# configuration directory, not this bundle. A relative \`./x.mjs\` therefore
# resolved to \`<profileDir>/x.mjs\`, failed to import, left the entry without a
# fiber, and the registry's mount audit rejected the entire preset with
# "<id> (./x.mjs): never started". The bare package form below resolves from the
# profile directory through this bundle's pnpm link, exactly as every shipped
# preset's rows do. The seven \`.mjs\` assets ship in this bundle directory and
# their own relative imports between each other still resolve beside the file.

- insert:
    - id: preset-miraculous-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: miraculous-standard
        name: ${q(preset.name)}
        description: ${q(preset.description)}
        order: ${preset.order}
        plugins:
`

writeFileSync(outFile, header + indented + '\n')
console.log(`wrote ${outFile}`)
console.log(`declaration: id=miraculous-standard order=${preset.order} name=${preset.name}`)
