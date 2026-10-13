import { z } from "zod"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir as osHomedir } from "node:os"

const Kind = z.enum(["bash", "webfetch", "websearch", "external_directory", "edit", "mcp"])

function compiles(s: string): boolean { try { new RegExp(s, "m"); return true } catch { return false } }
/** M1: an invalid regex is a config error, not a throw inside the rules tier. */
const RegexString = z.string().refine(compiles, { message: "invalid regular expression" })

export const RuleMatchSchema = z.union([
  z.object({ command: z.union([z.string(), z.array(z.string())]), subcommand: z.string().optional(), argsGlob: z.string().optional(), argsRegex: RegexString.optional() }),
  z.object({ pathWrite: z.array(z.string()).min(1) }),
  z.object({ deleteOutsideWorktree: z.literal(true) }),
  z.object({ urlHost: z.string() }),
  z.object({ pipeToNetwork: z.object({ sources: z.array(z.string()).optional(), fileGlobs: z.array(z.string()).optional() }) }),
  z.object({ downloadToInterpreter: z.literal(true) }),
  z.object({ regex: RegexString }),
])
export type RuleMatch = z.infer<typeof RuleMatchSchema>

export const RuleDefSchema = z.object({
  id: z.string().min(1),
  kinds: z.array(Kind).min(1),
  reason: z.string().min(1),
  match: z.union([RuleMatchSchema, z.array(RuleMatchSchema).min(1)]),
})
export type RuleDef = z.infer<typeof RuleDefSchema>

export const LayaQuestionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["choice", "noul", "score"]),
  role: z.enum(["verdict", "approve", "veto", "signal"]),
  instructions: z.string().min(1),
  criteria: z.union([z.record(z.string()), z.array(z.string())]),
  threshold: z.number().min(0).max(1).optional(),
  allowDeny: z.boolean().optional(),
}).superRefine((q, ctx) => {
  // T8: decide() only reads pTrue for approve/veto/signal and a choice for verdict.
  if (q.role === "verdict" && q.type !== "choice") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: "verdict questions must have type \"choice\"" })
  if (q.role !== "verdict" && q.type !== "noul") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: `${q.role} questions must have type "noul"` })
})
export type LayaQuestion = z.infer<typeof LayaQuestionSchema>

export const ConfigSchema = z.object({
  enabled: z.boolean(),
  kinds: z.array(Kind),
  judge: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string(),
    model: z.string().min(1),
    fallbackModel: z.string().nullable(),
    timeoutMs: z.number().int().min(100).max(60000),
    userMessageCount: z.number().int().min(1).max(20),
    contextTokenBudget: z.number().int().min(200).max(20000),
  }),
  laya: z.object({
    mode: z.enum(["off", "shadow", "active"]),
    baseUrl: z.string().url().nullable(),
    apiKey: z.string().nullable(),
    timeoutMs: z.number().int().min(20).max(5000),
    verdictThreshold: z.number().min(0.5).max(1),
    allowDeny: z.boolean(),
    questions: z.array(LayaQuestionSchema),
    disableQuestions: z.array(z.string()),
  }),
  rules: z.object({ disable: z.array(z.string()), custom: z.array(RuleDefSchema) }),
  cache: z.object({ sessionPatterns: z.boolean() }),
  feedback: z.object({ injectDenialReason: z.boolean(), toast: z.boolean() }),
  log: z.object({ path: z.string(), maxMb: z.number().min(1).max(1000) }),
})
export type Config = z.infer<typeof ConfigSchema>

export const DEFAULTS: Config = {
  enabled: true,
  kinds: ["bash", "webfetch", "websearch", "external_directory", "edit", "mcp"],
  judge: {
    baseUrl: "https://litellm.example.com/v1",
    apiKey: "{env:LITELLM_API_KEY}",
    model: "glm-5.3-flash",
    fallbackModel: null,
    timeoutMs: 8000,
    userMessageCount: 6,
    contextTokenBudget: 1500,
  },
  laya: {
    mode: "shadow",
    baseUrl: null,
    apiKey: null,
    timeoutMs: 150,
    verdictThreshold: 0.95,
    allowDeny: false,
    questions: [],
    disableQuestions: [],
  },
  rules: { disable: [], custom: [] },
  cache: { sessionPatterns: true },
  feedback: { injectDenialReason: true, toast: true },
  log: { path: "~/.local/share/blotto-mode/decisions.jsonl", maxMb: 50 },
}

const CONCAT_PATHS = new Set(["rules.custom", "laya.questions"])

export function mergeConfig(base: unknown, over: unknown, path = ""): unknown {
  if (Array.isArray(base) && Array.isArray(over)) return CONCAT_PATHS.has(path) ? [...base, ...over] : over
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(over)) {
      const p = path ? `${path}.${k}` : k
      out[k] = k in base ? mergeConfig(base[k], v, p) : v
    }
    return out
  }
  return over === undefined ? base : over
}
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v) }

export function expandString(s: string, env: NodeJS.ProcessEnv, homedir: string): string {
  let out = s.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? "")
  if (out === "~" || out.startsWith("~/")) out = homedir + out.slice(1)
  return out
}

function expandDeep(v: unknown, env: NodeJS.ProcessEnv, homedir: string): unknown {
  if (typeof v === "string") return expandString(v, env, homedir)
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, env, homedir))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x, env, homedir)]))
  return v
}

function readJson(path: string, log: (m: string) => void): unknown {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, "utf8")) } catch (e) { log(`blotto-mode: cannot parse ${path}: ${String(e)}`); return undefined }
}

export function loadConfig(opts: { worktree: string; homedir?: string; env?: NodeJS.ProcessEnv; log?: (m: string) => void }): Config {
  const homedir = opts.homedir ?? osHomedir()
  const env = opts.env ?? process.env
  const log = opts.log ?? ((m) => console.error(m))
  const globalPath = join(homedir, ".config/opencode/blotto-mode.json")
  const projectPath = join(opts.worktree, ".opencode/blotto-mode.json")
  let merged: unknown = DEFAULTS
  for (const p of [globalPath, projectPath]) {
    const layer = readJson(p, log)
    if (layer !== undefined) merged = mergeConfig(merged, layer)
  }
  const expanded = expandDeep(merged, env, homedir)
  const parsed = ConfigSchema.safeParse(expanded)
  let cfg: Config
  if (parsed.success) cfg = parsed.data
  else {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    log(`blotto-mode: invalid config, using defaults (${issues})`)
    cfg = ConfigSchema.parse(expandDeep(DEFAULTS, env, homedir))
  }
  if (env.BLOTTO_MODE === "off") cfg = { ...cfg, enabled: false }
  return cfg
}
