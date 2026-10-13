// refine.js — the refine_permissions tool handler: analyze session history,
// apply accepted rules to the global config, remember when we last looked.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  MAX_WINDOW_DAYS,
  DEFAULT_MIN_COUNT,
  STORAGE_KEY,
  resolveStartMs,
  analyzeSessions,
} from "./analyze.js"
import { parseConfig, existingAllowRules, applyRules, writeConfig } from "./config-store.js"

const xdg = (name, fallback) => process.env[name] || join(homedir(), fallback)

export function resolveConfigPath(explicit) {
  if (explicit) return explicit
  const dir = xdg("XDG_CONFIG_HOME", ".config/opencode")
  const json = join(dir, "opencode.json")
  if (existsSync(json)) return json
  const jsonc = join(dir, "opencode.jsonc")
  if (existsSync(jsonc)) return jsonc
  return json
}

export function resolveDbPath() {
  return join(xdg("XDG_DATA_HOME", ".local/share/opencode"), "opencode.db")
}

export { STORAGE_KEY } from "./analyze.js"

const readConfigText = (path) => readFileSync(path, "utf8")

export async function runAnalyze(ctx, options = {}) {
  const now = Date.now()
  const stored = await ctx.storage?.get(STORAGE_KEY)
  const startMs = resolveStartMs(
    typeof stored === "number" ? stored : null,
    now,
    Math.min(options.days ?? MAX_WINDOW_DAYS, MAX_WINDOW_DAYS),
  )
  const configPath = resolveConfigPath(options.configPath)
  // Only allow rules count as coverage — a broad `*: ask` must not hide usage.
  let existing = []
  try {
    existing = existingAllowRules(parseConfig(readConfigText(configPath)))
  } catch (error) {
    // Unreadable or unparseable config: report it and do NOT advance the marker.
    return {
      error: "config-unreadable",
      detail: error?.message ?? String(error),
      configPath,
      commandsScanned: 0,
      proposals: [],
      skipped: { denied: [], rare: [], covered: [] },
    }
  }
  const result = analyzeSessions({
    dbPath: options.dbPath ?? resolveDbPath(),
    startMs,
    endMs: now,
    existingRules: existing,
    minCount: options.minCount ?? DEFAULT_MIN_COUNT,
  })
  if (!result.error) {
    try {
      await ctx.storage?.set(STORAGE_KEY, now)
    } catch {
      // Storage is best effort; analysis still stands.
    }
  }
  return { ...result, minCount: options.minCount ?? DEFAULT_MIN_COUNT, configPath }
}

export async function runApply(ctx, options = {}, rules = []) {
  const configPath = resolveConfigPath(options.configPath)
  let text
  try {
    text = readConfigText(configPath)
  } catch (error) {
    return { error: "config-unreadable", detail: error?.message ?? String(error), added: [], alreadyPresent: [], skippedForSafety: [] }
  }
  let applied
  try {
    applied = applyRules(text, rules)
  } catch (error) {
    return { error: "config-unreadable", detail: error?.message ?? String(error), added: [], alreadyPresent: [], skippedForSafety: [] }
  }
  const { text: next, added, alreadyPresent, skippedForSafety } = applied
  if (added.length === 0) {
    return { added, alreadyPresent, skippedForSafety, configPath }
  }
  const { backupPath } = writeConfig(configPath, next)
  return { added, alreadyPresent, skippedForSafety, backupPath, configPath }
}

export function makeTool(ctx, options = {}) {
  return {
    name: "refine_permissions",
    description:
      "Analyze recent session history and propose safer shell allowlist rules for the OpenCode config (mode=analyze), or apply accepted rules (mode=apply).",
    input: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["analyze", "apply"] },
        rules: { type: "array", items: { type: "string" } },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    execute: async (input) => {
      try {
        const mode = input?.mode
        const result =
          mode === "apply"
            ? await runApply(ctx, options, input?.rules ?? [])
            : await runAnalyze(ctx, options)
        return { content: JSON.stringify(result, null, 2) }
      } catch (error) {
        // The agent always gets a structured result, never an exception.
        return {
          content: JSON.stringify(
            { error: "unexpected", detail: error?.message ?? String(error) },
            null,
            2,
          ),
        }
      }
    },
  }
}
