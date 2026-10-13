import parse, { type BpNode, type BpCommand, type BpWord, type BpScript } from "bash-parser"
import type { SimpleCommand, Redirect } from "./types"

export const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "telnet", "socat", "http", "https", "xh"])
/** Shells whose -c payload is a command string. */
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash", "mksh", "yash"])
/** A short-option cluster that includes c: -c, -lc, -xc, -ec (C1). */
export const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
const INTERPRETER_RE = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|perl|ruby|php|deno|bun|lua|tclsh|Rscript)$/
export function isInterpreter(name: string): boolean { return INTERPRETER_RE.test(name) }
/** find actions whose arguments, up to ; or +, are a command to run. */
export const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"])

interface WrapperSpec {
  /** Options that consume the following token. */
  withArg: string[]
  /** Known options that take no argument. */
  flags: string[]
  /** Positional tokens to skip after the options (timeout's duration). */
  skipPositional?: number
  /** Skip leading VAR=value tokens. */
  assignments?: boolean
}

export const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: { withArg: ["-u", "-g", "-C", "-p", "-h", "-r", "-t", "-T", "-U", "-D", "-R"], flags: ["-E", "-n", "-H", "-S", "-b", "-k", "-K", "-P", "-A", "-B", "-e", "-i", "-s", "-l", "-v"], assignments: true },
  doas: { withArg: ["-u", "-C"], flags: ["-n", "-s"] },
  pkexec: { withArg: ["--user"], flags: ["--disable-internal-agent", "--keep-cwd"] },
  run0: { withArg: ["-u", "--user", "-g", "--group", "-D", "--chdir", "--setenv", "--unit", "--property", "--description", "--slice", "--nice", "--machine", "--background"], flags: ["--no-ask-password", "-q", "--quiet"] },
  env: { withArg: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"], flags: ["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"], assignments: true },
  nohup: { withArg: [], flags: [] },
  nice: { withArg: ["-n", "--adjustment"], flags: [] },
  time: { withArg: ["-o", "-f"], flags: ["-p", "-v", "-a", "-l"] },
  command: { withArg: [], flags: ["-p", "-v", "-V"] },
  builtin: { withArg: [], flags: [] },
  exec: { withArg: ["-a"], flags: ["-c", "-l"] },
  xargs: { withArg: ["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"], flags: ["-0", "-r", "-t", "-p", "-x", "-o", "--null", "--no-run-if-empty", "--verbose"] },
  timeout: { withArg: ["-s", "-k", "--signal", "--kill-after"], flags: ["-v", "-f", "--foreground", "--preserve-status", "--verbose"], skipPositional: 1 },
  // I6: runners that used to hide their inner command.
  watch: { withArg: ["-n", "--interval", "-q", "--equexit"], flags: ["-d", "-t", "-b", "-e", "-g", "-c", "-x", "-p", "-w", "-C", "--differences", "--no-title", "--beep", "--errexit", "--chgexit", "--color", "--no-color", "--exec", "--precise", "--no-wrap"] },
  stdbuf: { withArg: ["-i", "-o", "-e"], flags: [] },
  ionice: { withArg: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"], flags: ["-t", "--ignore"] },
  chroot: { withArg: ["--userspec", "--groups"], flags: ["--skip-chdir"], skipPositional: 1 },
  flock: { withArg: ["-w", "--timeout", "-E", "--conflict-exit-code"], flags: ["-s", "-x", "-e", "-n", "-u", "-o", "-F", "--shared", "--exclusive", "--nonblock", "--unlock", "--close", "--no-fork", "--verbose"], skipPositional: 1 },
  strace: { withArg: ["-o", "-e", "-p", "-s", "-u", "-E", "-a", "-b", "-I", "-P", "-X", "-O", "-S", "-U"], flags: ["-f", "-ff", "-c", "-C", "-d", "-D", "-h", "-i", "-k", "-q", "-qq", "-r", "-t", "-tt", "-ttt", "-T", "-v", "-V", "-w", "-x", "-xx", "-y", "-yy", "-z", "-Z", "-F", "-n"] },
  busybox: { withArg: [], flags: [] },
  coproc: { withArg: [], flags: [] },
}

type PipelineRef = NonNullable<SimpleCommand["pipeline"]>

/** Shared across the outer parse and every inner re-parse. */
interface Ctx {
  /** Keeps pipeline ids unique. */
  nextPipelineId: number
  /** Set when anything could not be understood; the whole result becomes opaque. */
  opaque: boolean
  /** > 0 while walking a substitution whose output is executed as code (I5). */
  execDepth: number
}

export function parseBash(source: string): { commands: SimpleCommand[]; opaque: boolean } {
  const ctx: Ctx = { nextPipelineId: 0, opaque: false, execDepth: 0 }
  const out: SimpleCommand[] = []
  parseInto(source, out, false, undefined, ctx)
  return { commands: out, opaque: ctx.opaque }
}

/**
 * Parse `source` and append its commands to `out`; any failure marks ctx.opaque.
 * I7: bash-parser cannot parse here-strings (<<<) or |&. When the parse fails, retry with
 * those rewritten to < and | so the rules still see the commands; the result stays opaque.
 */
function parseInto(source: string, out: SimpleCommand[], pipedToNetwork: boolean, pipeline: PipelineRef | undefined, ctx: Ctx): void {
  let ast: BpScript
  try { ast = parse(source, { mode: "bash" }) } catch {
    ctx.opaque = true
    const rewritten = source.replace(/<<</g, "<").replace(/\|&/g, "|")
    if (rewritten === source) return
    try { ast = parse(rewritten, { mode: "bash" }) } catch { return }
  }
  const tmp: SimpleCommand[] = []
  try { walk(ast, tmp, pipedToNetwork, pipeline, ctx) } catch { ctx.opaque = true; return }
  out.push(...tmp)
}

function withExec(ctx: Ctx, exec: boolean, fn: () => void): void {
  if (exec) ctx.execDepth++
  try { fn() } finally { if (exec) ctx.execDepth-- }
}

/** Every $(...) and `...` inside `text`, balanced, outermost only. */
function substitutionsIn(text: string): string[] | undefined {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") {
      const j = text.indexOf("`", i + 1)
      if (j < 0) return undefined
      out.push(text.slice(i + 1, j)); i = j
    } else if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
      i += 2 // arithmetic $(( … )): not a substitution itself; keep scanning its body
    } else if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 0, j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++
        else if (text[j] === ")" && --depth === 0) break
      }
      if (j >= text.length) return undefined
      out.push(text.slice(i + 2, j)); i = j
    }
  }
  return out
}

function walkWords(words: (BpWord | undefined)[] | undefined, out: SimpleCommand[], pipedToNetwork: boolean, ctx: Ctx): void {
  for (const w of words ?? []) {
    for (const e of w?.expansion ?? []) {
      if (e.type === "CommandExpansion" && e.commandAST) { walk(e.commandAST, out, pipedToNetwork, undefined, ctx); continue }
      // C2: bash-parser does not descend into ${x:-$(cmd)} or $((... $(cmd) ...)). Re-parse what we
      // can find and mark the whole request opaque either way.
      if (e.type === "ParameterExpansion" || e.type === "ArithmeticExpansion") {
        const loc = (e as { loc?: { start: number; end: number } }).loc
        const text = w!.text
        const part = loc ? text.slice(loc.start, loc.end + 1) : text
        const subs = substitutionsIn(part)
        if (subs?.length === 0) continue
        ctx.opaque = true
        for (const s of subs ?? []) parseInto(s, out, pipedToNetwork, undefined, ctx)
      }
    }
  }
}

function walk(node: BpNode | undefined, out: SimpleCommand[], pipedToNetwork: boolean, pipeline: PipelineRef | undefined, ctx: Ctx): void {
  if (!node) return
  switch (node.type) {
    case "Script":
    case "CompoundList":
      for (const c of node.commands) walk(c, out, pipedToNetwork, pipeline, ctx)
      return
    case "Pipeline": {
      const cmds = node.commands
      const id = cmds.length >= 2 ? ctx.nextPipelineId++ : undefined
      for (let i = 0; i < cmds.length; i++) {
        const downstreamNetwork = cmds.slice(i + 1).some(isNetworkNode)
        walk(cmds[i], out, pipedToNetwork || downstreamNetwork, id === undefined ? pipeline : { id, index: i }, ctx)
      }
      return
    }
    case "LogicalExpression":
      walk(node.left, out, pipedToNetwork, pipeline, ctx); walk(node.right, out, pipedToNetwork, pipeline, ctx); return
    case "Subshell": walk(node.list, out, pipedToNetwork, pipeline, ctx); return
    case "For": walkWords(node.wordlist, out, pipedToNetwork, ctx); walk(node.do, out, pipedToNetwork, pipeline, ctx); return
    case "While": case "Until": walk(node.clause, out, pipedToNetwork, pipeline, ctx); walk(node.do, out, pipedToNetwork, pipeline, ctx); return
    case "If": walk(node.clause, out, pipedToNetwork, pipeline, ctx); walk(node.then, out, pipedToNetwork, pipeline, ctx); walk(node.else, out, pipedToNetwork, pipeline, ctx); return
    case "Case":
      walkWords([node.clause], out, pipedToNetwork, ctx)
      for (const c of node.cases) { walkWords(c.pattern, out, pipedToNetwork, ctx); walk(c.body, out, pipedToNetwork, pipeline, ctx) }
      return
    case "Function": walk(node.body, out, pipedToNetwork, pipeline, ctx); return
    case "Command": emitCommand(node, out, pipedToNetwork, pipeline, ctx); return
    default: ctx.opaque = true // unknown node type: do not guess
  }
}

function stripPath(name: string): string { return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name }

function unquote(text: string): string {
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) return text.slice(1, -1)
  return text
}

/**
 * The command string a shell (or script(1)) runs via -c. `index` is the position in args of
 * the token holding it. Option clusters containing c count as -c (C1); -o/-O take an argument.
 */
export function shellPayload(name: string, args: string[]): { index: number; text: string } | undefined {
  const isScript = name === "script"
  if (!SHELLS.has(name) && !isScript) return undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith("--command=")) return { index: i, text: a.slice("--command=".length) }
    const isC = SHELL_C_FLAG.test(a) || ((isScript || name === "fish") && a === "--command")
    if (!isC) continue
    let skip = a === "--command" ? 0 : [...a.slice(1)].filter((ch) => ch === "o" || ch === "O").length
    let j = i + 1
    for (; j < args.length; j++) {
      const b = args[j]!
      if (skip > 0) { skip--; continue }
      if (b === "--") { j++; break }
      if (/^[-+][a-zA-Z]+$/.test(b)) { skip += [...b.slice(1)].filter((ch) => ch === "o" || ch === "O").length; continue }
      if (b.startsWith("--")) continue
      break
    }
    return j < args.length ? { index: j, text: args[j]! } : undefined
  }
  return undefined
}

/** find's starting points: the operands before the first expression token; "." when none. */
export function findStartPaths(args: string[]): string[] {
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (a === "-H" || a === "-L" || a === "-P") { i++; continue }
    if (a === "-D") { i += 2; continue }
    if (/^-O\d*$/.test(a)) { i++; continue }
    break
  }
  const paths: string[] = []
  for (; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith("-") || a === "(" || a === ")" || a === "!" || a === ",") break
    paths.push(a)
  }
  return paths.length ? paths : ["."]
}

/** The commands find -exec/-execdir/-ok/-okdir would run, with {} replaced by each start path. */
export function findPayloads(args: string[]): string[] {
  const starts = findStartPaths(args)
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (!FIND_EXEC_ACTIONS.has(args[i]!)) continue
    const toks: string[] = []
    let j = i + 1
    for (; j < args.length && args[j] !== ";" && args[j] !== "+"; j++) toks.push(args[j]!)
    i = j
    if (!toks.length) continue
    for (const s of starts) out.push(toks.map((t) => shellQuote(t.replaceAll("{}", s))).join(" "))
  }
  return out
}

/** True when the node, looking through wrappers like sudo/env/bash -c, runs a network command. */
function isNetworkNode(n: BpNode): boolean {
  switch (n.type) {
    case "Command": return commandRunsNetwork(n)
    case "Pipeline": return n.commands.some(isNetworkNode)
    case "Script": case "CompoundList": return n.commands.some(isNetworkNode)
    case "LogicalExpression": return isNetworkNode(n.left) || isNetworkNode(n.right)
    case "Subshell": return isNetworkNode(n.list)
    default: return false
  }
}

function sourceRunsNetwork(s: string): boolean {
  try { return isNetworkNode(parse(s, { mode: "bash" })) } catch { return false }
}

function commandRunsNetwork(cmd: BpCommand): boolean {
  if (!cmd.name) return false
  let name = stripPath(unquote(cmd.name.text))
  let args = (cmd.suffix ?? []).filter((p) => p.type === "Word").map((p) => unquote((p as BpWord).text))
  for (let depth = 0; depth < 8; depth++) {
    if (NETWORK_COMMANDS.has(name)) return true
    const payload = shellPayload(name, args)
    if (payload) return sourceRunsNetwork(payload.text)
    if (SHELLS.has(name) || name === "script") return false
    if (name === "eval") return args.length > 0 && sourceRunsNetwork(args.join(" "))
    if (name === "find") return findPayloads(args).some(sourceRunsNetwork)
    const inner = unwrap(name, args)
    if (!inner) return false
    if (inner.leading !== undefined && sourceRunsNetwork(inner.leading)) return true
    if (!inner.rest.length) return false
    name = stripPath(inner.rest[0]!)
    args = inner.rest.slice(1)
  }
  return false
}

/**
 * Strip a wrapper's own options from its args. Returns undefined for non-wrappers.
 * `unknown` is set when an unrecognized option is followed by a non-option, since
 * that token may be the option's argument and the real command cannot be told apart.
 * `leading` is a command string carried by the wrapper itself (env -S, flock -c).
 */
function unwrap(name: string, args: string[]): { rest: string[]; unknown: boolean; leading?: string } | undefined {
  if (name === "srt") { const i = args.indexOf("--"); return { rest: i < 0 ? [] : args.slice(i + 1), unknown: false } }
  const spec = WRAPPERS[name]
  if (!spec) return undefined
  let i = 0
  let leading: string | undefined
  while (i < args.length) {
    const a = args[i]!
    if (a === "--") { i++; break }
    if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { i++; continue }
    if (!a.startsWith("-") || a === "-") break
    if (spec.withArg.includes(a)) {
      if (name === "env" && (a === "-S" || a === "--split-string")) leading = args[i + 1]
      i += 2; continue
    }
    if (spec.flags.includes(a) || (name === "nice" && /^-\d+$/.test(a)) || (a.startsWith("--") && a.includes("="))) { i++; continue }
    if (!a.startsWith("--") && a.length > 2) {
      // attached argument (-n1, -I{}) or combined flags (-0r)
      if (spec.withArg.includes(a.slice(0, 2))) {
        if (name === "env" && a.startsWith("-S")) leading = a.slice(2)
        i++; continue
      }
      if ([...a.slice(1)].every((ch) => spec.flags.includes("-" + ch))) { i++; continue }
    }
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith("-")) return { rest: [], unknown: true }
    i++
  }
  i += spec.skipPositional ?? 0
  let rest = args.slice(i)
  // flock FILE -c 'cmd'
  if (name === "flock" && (rest[0] === "-c" || rest[0] === "--command")) { leading = rest[1]; rest = [] }
  return { rest, unknown: false, leading }
}

/**
 * Re-parse a string that a wrapper will execute and append its commands to `out`.
 * The wrapper's pipeline slot and pipedToNetwork are the starting state of the inner
 * walk, so top-level inner commands inherit them while $(...) commands do not.
 */
function emitInner(source: string, out: SimpleCommand[], pipedToNetwork: boolean, pipeline: PipelineRef | undefined, ctx: Ctx): void {
  parseInto(source, out, pipedToNetwork, pipeline, ctx)
}

function emitCommand(cmd: BpCommand, out: SimpleCommand[], pipedToNetwork: boolean, pipeline: PipelineRef | undefined, ctx: Ctx): void {
  const parts = [...(cmd.prefix ?? []), ...(cmd.suffix ?? [])]
  /** Words whose substitutions are walked, in source order; argIndex links a word to args. */
  const expandable: { word: BpWord | undefined; argIndex?: number }[] = [{ word: cmd.name }]
  const args: string[] = []
  const redirects: Redirect[] = []
  for (const part of parts) {
    const t = (part as { type: string }).type
    if (part.type === "Redirect") {
      const op = part.op.text
      if (op.startsWith("<<")) ctx.opaque = true // heredoc / here-string
      if (op === ">" || op === ">>" || op === ">|" || op === "&>" || op === "&>>") redirects.push({ target: unquote(part.file.text), append: op.includes(">>") })
      expandable.push({ word: part.file })
    } else if (t === "Word") { expandable.push({ word: part as BpWord, argIndex: args.length }); args.push(unquote((part as BpWord).text)) }
    else if (t === "AssignmentWord") expandable.push({ word: part as BpWord })
    else ctx.opaque = true // heredoc marker (dless) or anything else unrecognized
  }
  const nameExpansions = cmd.name?.expansion ?? []
  const dynamicName = nameExpansions.some((e) => e.type === "CommandExpansion")
  // C2: a command name built from any expansion ($x, ${SHELL}, $(...)) cannot be named.
  if (nameExpansions.length) ctx.opaque = true
  const name = cmd.name && !dynamicName ? stripPath(unquote(cmd.name.text)) : undefined
  if (name !== undefined) {
    const self: SimpleCommand = { name, args, redirects, pipedToNetwork, raw: [name, ...args].join(" ") }
    if (pipeline) self.pipeline = pipeline
    if (ctx.execDepth > 0) self.outputExecuted = true
    out.push(self)
  }
  const payload = name !== undefined ? shellPayload(name, args) : undefined
  const execsArgs = name === "eval" || name === "source" || name === "."
  const net = pipedToNetwork || (name !== undefined && NETWORK_COMMANDS.has(name))
  for (const { word, argIndex } of expandable) {
    // I5: output of these substitutions is run as code: the command name itself, a shell's -c
    // payload, or any argument of eval / source / . .
    const exec = word === cmd.name ? dynamicName : argIndex !== undefined && (execsArgs || payload?.index === argIndex)
    withExec(ctx, exec, () => walkWords([word], out, net, ctx))
  }
  if (name === undefined) return
  if (name === "coproc") ctx.opaque = true // I6: background coprocess syntax is not modelled
  if (payload) { emitInner(payload.text, out, pipedToNetwork, pipeline, ctx); return }
  if (SHELLS.has(name) || name === "script") return
  if (name === "eval") { if (args.length) emitInner(args.join(" "), out, pipedToNetwork, pipeline, ctx); return }
  if (name === "find") { for (const p of findPayloads(args)) emitInner(p, out, pipedToNetwork, pipeline, ctx); return }
  const inner = unwrap(name, args)
  if (!inner) return
  if (inner.unknown) { ctx.opaque = true; return }
  const source = [...(inner.leading !== undefined ? [inner.leading] : []), ...inner.rest.map(shellQuote)].join(" ")
  if (source.trim()) emitInner(source, out, pipedToNetwork, pipeline, ctx)
}

function shellQuote(s: string): string { return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'" }

/**
 * I6: true when the command carries inline code a session glob must never cover: a shell,
 * interpreter, or find with -exec/-execdir/-ok/-okdir/-c/-e (or a -c cluster).
 */
export function carriesInlineCode(c: SimpleCommand): boolean {
  const shell = SHELLS.has(c.name) || c.name === "script" || c.name === "busybox"
  if (!shell && !isInterpreter(c.name) && c.name !== "find") return false
  return c.args.some((a) => FIND_EXEC_ACTIONS.has(a) || a === "-c" || a === "-e" || (shell && SHELL_C_FLAG.test(a)) || (isInterpreter(c.name) && /^-[a-zA-Z]*[ce][a-zA-Z]*$/.test(a)))
}
