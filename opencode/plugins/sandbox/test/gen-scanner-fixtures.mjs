#!/usr/bin/env bun
// Generator for test/scanner-fixtures.json — run by hand:
//   cd opencode/plugins/sandbox && bun test/gen-scanner-fixtures.mjs
// Isolated clone only; never reads the user's fork tree. See task-4 brief.
// Not a test: guard so `node --test` (which discovers this file) skips it.
if (typeof globalThis.Bun === "undefined") process.exit(0)

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const PIN = "7b3d4ce3a7"
const REPO = process.env.OPENCODE_FORK_REPO || "https://github.com/anomalyco/opencode"
const CLONE = "/tmp/opencode/fixture-fork"
const BUN = process.env.BUN || "bun"

// 1. clone-if-missing with pin check
if (existsSync(CLONE)) {
  const head = execSync("git rev-parse HEAD", { cwd: CLONE }).toString().trim()
  if (!head.startsWith(PIN)) {
    throw new Error(`clone HEAD ${head} does not start with ${PIN}; refusing to proceed`)
  }
} else {
  mkdirSync("/tmp/opencode", { recursive: true })
  execSync(`git clone ${REPO} ${CLONE} --no-hardlinks`, { stdio: "inherit" })
  execSync(`git -C ${CLONE} checkout ${PIN}`, { stdio: "inherit" })
}
// 2. bun install --frozen-lockfile (idempotent)
execSync(`${BUN} install --frozen-lockfile`, { cwd: CLONE, stdio: "inherit" })

// 3. import parsers from the clone
const idx = await import(pathToFileURL(`${CLONE}/packages/core/node_modules/effect/dist/index.js`).href)
const Effect = idx.Effect
const parseMod = await import(pathToFileURL(`${CLONE}/packages/core/src/shell/parse.ts`).href)
const ShellParse = parseMod.ShellParse

// segmenter from the plugin (Task 1)
const segMod = await import("../segments.js")
const segmentCommand = segMod.segmentCommand

const cwd = process.cwd()
const SHELL = "/bin/bash"
const ABS_CWD = process.cwd()

async function runScan(input, portable) {
  try {
    const r = await Effect.runPromise(ShellParse.scan(input, SHELL, ABS_CWD, { portable }))
    return { kind: "scanned", resources: r.commands.map((c) => c.resource) }
  } catch (e) {
    const m = String(e && e.message ? e.message : e)
    const reason = m.includes(":") ? m.slice(m.lastIndexOf(":") + 1).trim() : m
    return { kind: "opaque", resources: [], reason }
  }
}

// 3. corpus
const sixLine = [
  "set -e",
  'git status --short',
  "git add docs/x",
  'git commit -m "Add plan for a && b"',
  "git log --oneline -5",
  "git status --short",
].join("\n")

const corpus = [
  { name: "canonical pipeline example", input: "python3 scripts/test_render_diagrams.py 2>&1 | tail -5" },
  { name: "canonical six-line set -e git script", input: sixLine },
  { name: "accept: three-line set -e script", input: "set -e\ngit status --short\ngit add docs/x" },
  { name: "accept: make && make install", input: "make && make install" },
  { name: "accept: a || b; c | d", input: "a || b; c | d" },
  { name: "accept: quoted operators in commit message", input: 'git commit -q -m "Add plan for a && b SVG"' },
  { name: "accept: single-quoted pipe", input: "echo 'a|b'" },
  { name: "accept: double quote inside single quotes", input: "echo '\"hi\"'" },
  { name: "accept: trailing backslash in single quotes", input: "echo 'a\\'" },
  { name: "accept: backslash-escaped semicolon", input: "echo a\\;b" },
  { name: "accept: backslash-escaped pipe", input: "echo x\\|y" },
  { name: "accept: trailing newline", input: "git log\n" },
  { name: "accept: blank inner lines dropped", input: "git log\n\n\ngit status\n" },
  { name: "accept: tab/space trimming", input: "git log \t\n\t\ngit status\t" },
  { name: "accept: trimmed segments around ;", input: "a ; \t b" },
  { name: "accept: fd-dup in pipeline", input: "python3 x.py 2>&1 | tail" },
  { name: "accept: cmd >&2", input: "cmd >&2" },
  { name: "accept: cmd <&0", input: "cmd <&0" },
  { name: "accept: raw CR as separator (single)", input: "git log\r" },
  { name: "accept: raw CR between commands", input: "git log\r\ngit status" },
  { name: "accept: mixed CR/LF", input: "git log\r\r\n\rgit status\r" },
  { name: "cwd/decl: cd /tmp && git status", input: "cd /tmp && git status" },
  { name: "cwd/decl: export FOO=1 && git status", input: "export FOO=1 && git status" },
  { name: "cwd/decl: cd ~/forge && make", input: "cd ~/forge && make" },
  { name: "CRLF: git log CRLF git status", input: "git log\r\ngit status --short" },
  { name: "lexicon: git -c core.pager=cat log | head -5", input: "git -c core.pager=cat log | head -5" },
  { name: "reject: subshell", input: "( cd /tmp && pwd )" },
  { name: "reject: command substitution $()", input: "echo $(date)" },
  { name: "reject: backticks", input: "echo `date`" },
  { name: "reject: unterminated single quote", input: "echo 'unterminated" },
  { name: "reject: heredoc", input: "cat <<EOF" },
  { name: "reject: background ampersand", input: "sleep 5 &" },
  { name: "reject: &> bashism", input: "python a &> /dev/null" },
  { name: "reject: redirect-and &&", input: "echo x >&& y" },
  { name: "reject: <&> redirect-and", input: "cat <&> f" },
  { name: "reject: pipe-stderr |&", input: "cmd |& cat" },
  { name: "reject: ansi quote $'", input: "echo $'x'" },
  { name: "reject: unquoted comment", input: "ls && echo # done" },
  { name: "reject: unterminated double quote", input: 'echo "unterminated' },
  { name: "reject: empty segment ;;", input: "true ;; false" },
  { name: "reject: trailing empty segment", input: "true && " },
  { name: "reject: empty input", input: "" },
  { name: "reject: whitespace-only input", input: "   " },
  { name: "reject: blank lines only", input: "\n\n" },
  { name: "totality: NUL byte", input: "\x00", divergent: true },
  { name: "totality: lone surrogate", input: "\ud800" },
  { name: "totality: 10k a's", input: "a".repeat(10000) },
  { name: "totality: large mixed input", input: "git status\n" + "x ".repeat(10000) + "\nmake test" },
]

const cases = []
for (const c of corpus) {
  const portable = await runScan(c.input, true)
  const treeSitter = await runScan(c.input, false)

  // parity: if both scanned, resources must be equal (loud on mismatch),
  // unless the corpus entry explicitly acknowledges a known divergence.
  if (
    portable.kind === "scanned" &&
    treeSitter.kind === "scanned" &&
    !c.divergent &&
    JSON.stringify(portable.resources) !== JSON.stringify(treeSitter.resources)
  ) {
    throw new Error(
      `PARSER DISAGREEMENT (both scanned) for ${JSON.stringify(c.input)}:\n` +
        `  portable: ${JSON.stringify(portable.resources)}\n` +
        `  treeSitter: ${JSON.stringify(treeSitter.resources)}`,
    )
  }

  const seg = segmentCommand(c.input)
  const segments = seg.ok ? seg.segments : []
  const segmenterReason = seg.ok ? null : seg.reason

  // elided: segments dropped by BOTH parsers as cwd/declaration families
  // (segments present in segments[] but absent from the union of both
  // resource sets). Raw-\\r / parser-divergent cases therefore keep
  // elided: [] and are flagged via parserDivergent instead.
  const resSet = new Set([...portable.resources, ...treeSitter.resources])
  const elided = segments.filter((s) => !resSet.has(s))

  const parserDivergent =
    JSON.stringify(portable.resources) !== JSON.stringify(treeSitter.resources)

  cases.push({
    name: c.name,
    input: c.input,
    elided,
    parserDivergent,
    segments,
    segmenter: { ok: seg.ok, reason: segmenterReason },
    resources: {
      portable: portable.resources,
      treeSitter: treeSitter.resources,
    },
    kind: portable.kind,
    opaqueReason: portable.kind === "opaque" ? portable.reason : null,
    acknowledgedDivergence: c.divergent === true,
  })
}

const out = {
  generatedFrom: { repo: REPO, commit: PIN },
  cases,
}

const target = new URL("./scanner-fixtures.json", import.meta.url)
writeFileSync(target, JSON.stringify(out, null, 2) + "\n")
console.log(`wrote ${cases.length} cases to ${target.pathname}`)
