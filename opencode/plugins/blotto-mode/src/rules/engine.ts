import { resolve } from "node:path"
import type { Config, RuleDef, RuleMatch } from "../config"
import type { ActionRequest, SimpleCommand, Tier } from "../types"
import { globMatch } from "../glob"
import { expandHome } from "../request"
import { DEFAULT_RULES } from "./defaults"
import { findStartPaths } from "../bash"

const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "perl", "ruby", "eval", "source", "."])
const DOWNLOADERS = new Set(["curl", "wget", "http", "https", "xh"])
const RECURSIVE_RM = /^-[a-zA-Z]*[rR][a-zA-Z]*$/
const READERS = new Set(["cat", "head", "tail", "less", "more", "bat", "base64", "xxd", "od", "strings", "grep", "awk", "sed", "jq", "yq"])
/** git global options that consume the next token (M2). */
const GIT_GLOBAL_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--list-cmds"])

/** M1: rule regexes are compiled once. Invalid ones throw here and the rules tier fails closed. */
const compiled = new Map<string, RegExp>()
function regexFor(src: string): RegExp {
  let re = compiled.get(src)
  if (!re) { re = new RegExp(src, "m"); compiled.set(src, re) }
  return re
}
function precompile(rules: RuleDef[]): void {
  for (const r of rules) for (const m of Array.isArray(r.match) ? r.match : [r.match]) {
    // A bad pattern (only reachable by bypassing ConfigSchema) is left to throw at evaluation time.
    try { if ("regex" in m) regexFor(m.regex); if ("argsRegex" in m && m.argsRegex !== undefined) regexFor(m.argsRegex) } catch { /* fail closed later */ }
  }
}

/** First non-option token after the command, skipping git's global options with arguments. */
function subcommandOf(c: SimpleCommand): string | undefined {
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!
    if (c.name === "git" && GIT_GLOBAL_WITH_ARG.has(a)) { i++; continue }
    if (!a.startsWith("-")) return a
  }
  return undefined
}

export function activeRules(cfg: Config): RuleDef[] {
  const disabled = new Set(cfg.rules.disable)
  // Copy: never mutate DEFAULT_RULES. The configured log (and its rotated sibling) joins write-self.
  // Paths keep any leading "~"; pathGlob expands it with the homedir given to evaluateRules.
  const logPaths = [cfg.log.path, cfg.log.path + ".1"]
  const defaults = DEFAULT_RULES.filter((r) => !disabled.has(r.id)).map((r): RuleDef => {
    if (r.id !== "write-self") return r
    const ms = Array.isArray(r.match) ? r.match : [r.match]
    return { ...r, match: [...ms, { pathWrite: logPaths }] }
  })
  const rules = [...defaults, ...cfg.rules.custom]
  precompile(rules)
  return rules
}

export function evaluateRules(req: ActionRequest, rules: RuleDef[], homedir: string): { ruleId: string; reason: string } | undefined {
  for (const rule of rules) {
    if (!rule.kinds.includes(req.kind)) continue
    const matches = Array.isArray(rule.match) ? rule.match : [rule.match]
    if (matches.some((m) => matchOne(m, req, homedir))) return { ruleId: rule.id, reason: rule.reason }
  }
  return undefined
}

export function rulesTier(rules: RuleDef[], homedir: string): Tier {
  return async (req, env) => {
    const t0 = performance.now()
    const hit = evaluateRules(req, rules, homedir)
    env.trace.rules = { hit: hit?.ruleId ?? null, ms: +(performance.now() - t0).toFixed(2) }
    return hit ? { status: "deny", reason: hit.reason, settledBy: "rules", ruleId: hit.ruleId } : undefined
  }
}

function matchOne(m: RuleMatch, req: ActionRequest, homedir: string): boolean {
  if ("regex" in m) return regexFor(m.regex).test(req.pattern)
  if ("urlHost" in m) return !!req.url && globMatch(m.urlHost, req.url.hostname)
  if ("pathWrite" in m) return writeTargets(req, homedir).some((t) => m.pathWrite.some((g) => pathGlob(g, t, homedir)))
  if (req.kind !== "bash" || !req.commands) return false
  if ("deleteOutsideWorktree" in m) return req.commands.some((c) => isRecursiveDeleteOutside(c, req, homedir))
  if ("downloadToInterpreter" in m) return downloaderToInterpreter(req.commands)
  if ("pipeToNetwork" in m) {
    const srcs = m.pipeToNetwork.sources ?? []
    const globs = m.pipeToNetwork.fileGlobs ?? []
    return req.commands.some((c) => c.pipedToNetwork && (srcs.includes(c.name) ||
      (READERS.has(c.name) && globs.some((g) => c.args.filter((a) => !a.startsWith("-")).some((a) => pathGlob(g, resolveArg(a, req, homedir, c), homedir))))))
  }
  if ("command" in m) {
    const names = Array.isArray(m.command) ? m.command : [m.command]
    return req.commands.some((c) => {
      if (!names.includes(c.name)) return false
      if (m.subcommand !== undefined && subcommandOf(c) !== m.subcommand) return false
      if (m.argsGlob !== undefined && !globMatch(m.argsGlob, " " + c.args.join(" "))) return false
      if (m.argsRegex !== undefined && !regexFor(m.argsRegex).test(" " + c.args.join(" "))) return false
      return true
    })
  }
  return false
}

/**
 * A downloader and an interpreter in the same pipeline, the interpreter strictly downstream; or (I5)
 * a downloader whose output is executed: `eval "$(curl …)"`, `sh -c "$(curl …)"`, `$(curl …)`.
 */
function downloaderToInterpreter(cmds: SimpleCommand[]): boolean {
  return cmds.some((a) => {
    if (!DOWNLOADERS.has(a.name)) return false
    if (writesToFile(a.args)) return false
    if (a.outputExecuted) return true
    if (!a.pipeline) return false
    return cmds.some((b) => b.pipeline && b.pipeline.id === a.pipeline!.id && b.pipeline.index > a.pipeline!.index && INTERPRETERS.has(b.name))
  })
}

const STDOUT_TARGETS = new Set(["-", "/dev/stdout"])
/** True only when the downloader's output goes to a real file (not stdout). */
function writesToFile(args: string[]): boolean {
  let file = false
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!
    if (x === "-o" || x === "-O" || x === "--output") {
      if (STDOUT_TARGETS.has(args[i + 1] ?? "")) return false
      file = true
    } else if (x.startsWith("--output=")) {
      if (STDOUT_TARGETS.has(x.slice(9))) return false
      file = true
    } else {
      const m = /^-[a-zA-Z]*[oO](-|\/dev\/stdout)$/.exec(x)
      if (m) return false
    }
  }
  return file
}

function isRecursiveDeleteOutside(c: SimpleCommand, req: ActionRequest, homedir: string): boolean {
  let targets: string[]
  if (c.name === "rm") {
    const recursive = c.args.some((a) => RECURSIVE_RM.test(a) || a === "--recursive")
    if (!recursive) return false
    targets = c.args.filter((a) => !a.startsWith("-"))
  } else if (c.name === "find" && c.args.includes("-delete")) {
    // I6: find <paths> … -delete removes everything under its start paths.
    targets = findStartPaths(c.args)
  } else return false
  const home = resolve(homedir)
  return targets.some((t) => {
    const abs = resolveArg(t, req, homedir, c)
    if (abs === "/" || abs === home) return true
    return !isWithin(abs, resolve(req.worktree)) && !abs.startsWith("/tmp/")
  })
}

function resolveArg(a: string, req: ActionRequest, homedir: string, c?: SimpleCommand): string {
  const cwd = effectiveCwd(req, homedir, c)
  return resolve(cwd, expandHome(stripTrailingSlash(a), homedir))
}
function stripTrailingSlash(p: string): string { return p.length > 1 ? p.replace(/\/+$/, "") : p }

/** Only `cd`s that come before `cmd` in the command list affect how cmd's relative paths resolve. */
function effectiveCwd(req: ActionRequest, homedir: string, cmd?: SimpleCommand): string {
  let cwd = req.directory
  for (const c of req.commands ?? []) {
    if (c === cmd) break
    if (c.name !== "cd") continue
    const t = c.args.find((a) => !a.startsWith("-"))
    if (t) cwd = resolve(cwd, expandHome(t, homedir))
    else if (!c.args.includes("-")) cwd = resolve(homedir) // T4a: bare `cd` goes home
  }
  return cwd
}

function isWithin(p: string, base: string): boolean { return p === base || p.startsWith(base.endsWith("/") ? base : base + "/") }

function writeTargets(req: ActionRequest, homedir: string): string[] {
  if (req.kind === "edit" || req.kind === "external_directory") return req.path ? [req.path] : []
  if (req.kind !== "bash" || !req.commands) return []
  const out: string[] = []
  for (const c of req.commands) {
    for (const r of c.redirects) out.push(resolveArg(r.target, req, homedir, c))
    const files = c.args.filter((a) => !a.startsWith("-"))
    switch (c.name) {
      case "rm": case "rmdir": case "shred": case "unlink": case "truncate": case "tee": case "touch": case "mkdir": case "chmod": case "chown":
        for (const f of files) out.push(resolveArg(f, req, homedir, c)); break
      case "mv": case "cp": case "install": case "ln": case "rsync":
        if (files.length) out.push(resolveArg(files[files.length - 1]!, req, homedir, c)); break
      case "sed": case "perl":
        if (c.args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) for (const f of files.slice(1)) out.push(resolveArg(f, req, homedir, c)); break
      case "git":
        if (files[0] === "config" && c.args.includes("--global")) out.push(resolve(homedir, ".gitconfig")); break
      case "curl": case "wget":
        for (const f of downloadOutputs(c)) out.push(resolveArg(f, req, homedir, c)); break
    }
  }
  return out
}

/** T4b: files curl -o/--output and wget -O/--output-document (and wget's -o log) write; stdout excluded. */
function downloadOutputs(c: SimpleCommand): string[] {
  const out: string[] = []
  const add = (t: string | undefined) => { if (t !== undefined && t !== "" && !STDOUT_TARGETS.has(t)) out.push(t) }
  const long = c.name === "curl" ? ["--output"] : ["--output-document", "--output-file", "--append-output"]
  const short = c.name === "curl" ? "o" : "Oo"
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!
    const eq = long.find((l) => a.startsWith(l + "="))
    if (eq) { add(a.slice(eq.length + 1)); continue }
    if (long.includes(a)) { add(c.args[++i]); continue }
    if (!/^-[a-zA-Z]/.test(a) || a.startsWith("--")) continue
    // short cluster: -o FILE, -sSLo FILE, wget -qO- / -Ofile
    for (let k = 1; k < a.length; k++) {
      if (!short.includes(a[k]!)) continue
      if (k === a.length - 1) add(c.args[++i])
      else if (c.name === "wget") add(a.slice(k + 1))
      break
    }
  }
  return out
}

function pathGlob(glob: string, abs: string, homedir: string): boolean {
  const g = expandHome(glob, homedir)
  if (g.endsWith("/**")) { const base = g.slice(0, -3); if (base.startsWith("**/")) return abs.includes(base.slice(2) + "/") || abs.endsWith(base.slice(2)); if (base.includes("*")) return globMatch(base, abs) || globMatch(base + "/*", abs); return isWithin(abs, base) }
  if (g.startsWith("**/")) return abs.endsWith("/" + g.slice(3)) || globMatch(g.slice(3), abs.slice(abs.lastIndexOf("/") + 1)) && !g.slice(3).includes("/")
  if (g.includes("*")) return globMatch(g, abs) || globMatch(g + "/**", abs)
  return abs === g || isWithin(abs, g)
}
