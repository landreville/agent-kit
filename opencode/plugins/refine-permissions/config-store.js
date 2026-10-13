// config-store.js — read and surgically update the OpenCode JSONC config.
//
// The global config carries hand-written comments and historical backup
// provenance, so edits are anchored text insertions, never re-serialization.

import { copyFileSync, writeFileSync, readFileSync } from "node:fs"
import { ruleCovers, familyDenied } from "./policy.js"

// Remove // and /* */ comments outside strings. Comment characters inside
// strings (URLs like https://…) survive untouched.
export function stripJsonComments(text) {
  if (typeof text !== "string") return ""
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 1
      continue
    }
    out += ch
  }
  return out
}

export function parseConfig(text) {
  try {
    return JSON.parse(stripJsonComments(text))
  } catch (error) {
    throw new Error(`invalid-config: ${error?.message ?? error}`)
  }
}

// Allowlist rule strings the config already carries: v1 `permission.bash`
// keys, or v2 `permissions` shell resources.
export function existingRules(parsed) {
  const v1 = parsed?.permission?.bash
  if (v1 && typeof v1 === "object") return Object.keys(v1)
  const v2 = parsed?.permissions
  if (Array.isArray(v2)) {
    return v2.filter((rule) => rule && rule.action === "shell").map((rule) => rule.resource)
  }
  return []
}

// Rules that actually GRANT permission — `ask` and `deny` entries never count
// as coverage, so a broad `"*": "ask"` must not shadow a safe proposal.
export function existingAllowRules(parsed) {
  return existingRuleEntries(parsed)
    .filter(({ effect }) => effect === "allow")
    .map(({ rule }) => rule)
}

// Every rule with its effect, for detecting rules that already decide a family.
export function existingRuleEntries(parsed) {
  const v1 = parsed?.permission?.bash
  if (v1 && typeof v1 === "object") {
    return Object.entries(v1).map(([rule, effect]) => ({ rule, effect }))
  }
  const v2 = parsed?.permissions
  if (Array.isArray(v2)) {
    return v2
      .filter((rule) => rule && rule.action === "shell")
      .map((rule) => ({ rule: rule.resource, effect: rule.effect }))
  }
  return []
}

// --- Applying rules -----------------------------------------------------------------

const V1_BASH_OPENER = /^([ \t]*)"bash"\s*:\s*\{/
const V1_BROAD_ASK = /^[ \t]*"\*"\s*:\s*"ask",?[ \t]*$/
const V2_OPENER = /^([ \t]*)"permissions"\s*:\s*\[/
const V2_BROAD_ASK = /^[ \t]*\{[^{}]*"resource"\s*:\s*"\*"[^{}]*"effect"\s*:\s*"ask"[^{}]*\},?[ \t]*$/
const PERMISSION_OPENER = /^([ \t]*)"permission"\s*:\s*\{/

const PATTERN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._*/@:=-]*$/

// Proposed patterns carry no shell metacharacters (rejects ; & | $ ` " ' < >).
export function isValidPattern(pattern) {
  return typeof pattern === "string" && PATTERN_SHAPE.test(pattern)
}

const prefixOf = (pattern) => pattern.replace(/ \*$/, "")

// Insert new allow rules after the block's broad-ask rule so the last matching
// rule is the new allow (V2 semantics: last match wins). Falls back to the
// block opener when no broad-ask rule exists.
const insertionIndex = (lines, openerRe, broadAskRe) => {
  const opener = lines.findIndex((line) => openerRe.test(line))
  if (opener === -1) return -1
  for (let i = opener + 1; i < lines.length; i++) {
    if (broadAskRe.test(lines[i])) return i
    if (/^[ \t]*[\}\]]/.test(lines[i])) break
  }
  return opener
}

export function applyRules(text, patterns) {
  const entries = existingRuleEntries(parseConfig(text))
  const allowRules = entries.filter(({ effect }) => effect === "allow").map(({ rule }) => rule)
  // A specific (non-broad) ask/deny rule already decides the family; never
  // write a duplicate key the user's decision would override anyway.
  const restrictingRules = entries
    .filter(({ rule, effect }) => effect !== "allow" && rule !== "*")
    .map(({ rule }) => rule)
  const added = []
  const alreadyPresent = []
  const skippedForSafety = []

  for (const pattern of patterns ?? []) {
    if (!isValidPattern(pattern)) {
      skippedForSafety.push({ pattern, reason: "invalid-pattern" })
      continue
    }
    const prefix = prefixOf(pattern)
    const reason = familyDenied(prefix)
    if (reason) {
      skippedForSafety.push({ pattern, reason })
      continue
    }
    if (allowRules.some((rule) => ruleCovers(rule, prefix))) {
      alreadyPresent.push(pattern)
      continue
    }
    if (restrictingRules.some((rule) => ruleCovers(rule, prefix))) {
      alreadyPresent.push(pattern)
      continue
    }
    added.push(pattern)
  }

  if (added.length === 0) return { text, added, alreadyPresent, skippedForSafety }

  const lines = text.split("\n")
  const newLines = []

  const v2At = insertionIndex(lines, V2_OPENER, V2_BROAD_ASK)

  const v1Opener = lines.findIndex((line) => V1_BASH_OPENER.test(line))
  const v1At = insertionIndex(lines, V1_BASH_OPENER, V1_BROAD_ASK)

  if (v1At !== -1) {
    const indent = (lines[v1Opener].match(V1_BASH_OPENER)?.[1] ?? "") + "  "
    for (const pattern of added) newLines.push(`${indent}"${pattern}": "allow",`)
    lines.splice(v1At + 1, 0, ...newLines)
    return { text: lines.join("\n"), added, alreadyPresent, skippedForSafety }
  }

  const permissionAt = lines.findIndex((line) => PERMISSION_OPENER.test(line))
  if (permissionAt !== -1) {
    // v1-shaped config without a bash block: create one, broad ask first so
    // the new allows still win last-match-wins. The last entry carries no
    // trailing comma — JSON forbids it.
    const indent = (lines[permissionAt].match(PERMISSION_OPENER)?.[1] ?? "") + "  "
    const entries = added.map((pattern) => `${indent}  "${pattern}": "allow",`)
    entries[entries.length - 1] = entries[entries.length - 1].replace(/,$/, "")
    lines.splice(permissionAt + 1, 0, `${indent}"bash": {`, `${indent}  "*": "ask",`, ...entries, `${indent}},`)
    return { text: lines.join("\n"), added, alreadyPresent, skippedForSafety }
  }

  if (v2At !== -1) {
    const indent = (lines[v2At].match(V2_OPENER)?.[1] ?? "") + "  "
    for (const pattern of added) {
      newLines.push(`${indent}{ "action": "shell", "resource": "${pattern}", "effect": "allow" },`)
    }
    lines.splice(v2At + 1, 0, ...newLines)
    return { text: lines.join("\n"), added, alreadyPresent, skippedForSafety }
  }

  throw new Error("invalid-config: no permission.bash block or permissions array to extend")
}

export function writeConfig(configPath, newText) {
  // Validate before touching the file: never write content we know is broken.
  parseConfig(newText)
  const backupPath = configPath.replace(/^(.*)(\.jsonc?)$/, `$1$2.pre-refine-permissions-backup-${Date.now()}$2`)
  copyFileSync(configPath, backupPath)
  try {
    writeFileSync(configPath, newText)
    parseConfig(readFileSync(configPath, "utf8"))
  } catch (error) {
    try {
      copyFileSync(backupPath, configPath)
    } catch {
      // keep the original failure if restoring also fails
    }
    throw error
  }
  return { backupPath }
}
