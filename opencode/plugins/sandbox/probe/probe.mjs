// probe/probe.mjs — end-to-end probe for @anthropic-ai/sandbox-runtime in
// both host modes.
//
// Mode A is the library default (the vendored apply-seccomp helper on).
// Ubuntu hosts with kernel.apparmor_restrict_unprivileged_userns=1
// capability-strip the nested user namespace apply-seccomp needs, so there
// every wrapped command dies at startup with the apply-seccomp signature —
// an expected host outcome, not a probe failure: the probe detects it,
// abandons Mode A, and falls through to Mode B. Mode B
// (allowAllUnixSockets: true) skips apply-seccomp entirely, so the sandbox
// runs in bwrap's own namespaces and works on such hosts.
//
// Assertion 2 (a denied write) is platform-split per the review ruling: the
// must-hold clause in BOTH modes is the non-zero exit plus bwrap's
// "Read-only file system" marker in stderr. The violations.length > 0
// attribution clause is hard only on macOS (seatbelt log monitor); on Linux
// it rides on apply-seccomp's observer, which Mode B skips, so there it is
// informational and prints "SKIP (unattributed on this platform)" when the
// store is empty instead of counting as a failure.
//
// Each assertion prints PASS or FAIL per mode; the final line is the
// HOST-MODE verdict — the value runtime.js's self-test must reproduce on
// this host. Exits non-zero if any counted assertion fails (the excused
// Mode A startup death and an unattributed write denial on Linux do not
// count).

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"

const PROBE_OUTSIDE = `${process.env.HOME}/.sandbox-probe-outside`
const APPLY_SECCOMP_SIGNATURE = /apply-seccomp:/
const WRITE_DENIED_MARKER = /Read-only file system/
const IS_MACOS = process.platform === "darwin"

// Start clean so the touch assertions are about creating a *new* file
// outside the allowed write roots, not touching a leftover from an earlier
// run.
rmSync(PROBE_OUTSIDE, { force: true })

// Production attribution shape: commandIds are ≥128-bit random base64url,
// never fixed short strings.
const newCommandId = () => randomBytes(16).toString("base64url")

// Wrap `cmd` with `networkExtra` merged into the network config, run it
// under /bin/bash inside the sandbox, and return its exit code, captured
// stdout/stderr, and every violation attributed to `id`. stdout and stderr
// are piped and re-emitted verbatim (what stdio "inherit" would have
// printed) so the apply-seccomp startup signature and the write-denied
// marker are detectable and the echoed payload is assertable. A child
// "error" event resolves as a failed run (-1) instead of hanging, and the
// code promise settles on "close" (process exited AND stdio drained).
//
// Each call re-initializes with this command's config — which requires a
// reset() first: initialize() is first-call-wins for the process (it
// early-returns while initializationPromise is set, without applying the
// new config), and only reset() clears that promise. Without the reset,
// Mode B would silently keep Mode A's config.
async function run(cmd, id, networkExtra) {
  await SandboxManager.reset()
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [], ...networkExtra },
    filesystem: { denyRead: [], allowWrite: [process.cwd(), "/tmp"], denyWrite: [] },
  })
  const wrapped = await SandboxManager.wrapWithSandbox(cmd, "/bin/bash", undefined, undefined, {
    commandId: id,
    commandText: cmd,
  })
  const child = spawn(wrapped, { shell: true, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
    process.stderr.write(chunk)
  })
  const code = await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`spawn error: ${err}\n`)
      resolve(-1)
    })
    child.on("close", (closeCode) => resolve(closeCode ?? -1))
  })
  return {
    code,
    stdout,
    stderr,
    violations: SandboxManager.getSandboxViolationStore().getViolationsForCommand(id),
  }
}

// The four assertions, in brief order. `check` is the counted must-hold;
// `skip` marks an informational clause rendered as SKIP; `detail` renders
// the evidence line.
const ASSERTIONS = [
  {
    n: 1,
    cmd: "echo hi",
    description: "echo hi → exit 0, violations.length === 0",
    check: (r) => r.code === 0 && r.violations.length === 0,
    detail: (r) => `exit=${r.code} violations=${r.violations.length}`,
  },
  {
    n: 2,
    cmd: `touch "$HOME/.sandbox-probe-outside"`,
    description: `touch "$HOME/.sandbox-probe-outside" → non-zero exit, write denied, violations attributed`,
    // Must-hold (both modes, per the review ruling): the command failed AND
    // bwrap's read-only enforcement is the stated reason. Attribution is
    // hard only on macOS (seatbelt log monitor); on Linux it rides on
    // apply-seccomp's observer, which Mode B skips — informational there.
    check: (r) =>
      r.code !== 0 && (IS_MACOS ? r.violations.length > 0 : WRITE_DENIED_MARKER.test(r.stderr)),
    skip: (r) => !IS_MACOS && r.violations.length === 0,
    detail: (r) =>
      !IS_MACOS && r.violations.length === 0
        ? `exit=${r.code} violations=0 — attribution: SKIP (unattributed on this platform); ` +
          `write-denied marker: ${WRITE_DENIED_MARKER.test(r.stderr) ? "present" : "MISSING"}`
        : `exit=${r.code} violations=${r.violations.length}` +
          (r.violations.length > 0 ? ` first="${r.violations[0].line}"` : ""),
  },
  {
    n: 3,
    cmd: "curl -s https://example.com",
    description: "curl -s https://example.com → non-zero exit, violation mentions the network block",
    check: (r) =>
      r.code !== 0 && r.violations.some((v) => /network-outbound|network|egress|proxy/i.test(v.line)),
    detail: (r) =>
      `exit=${r.code} violations=${r.violations.length}` +
      (r.violations.length > 0 ? ` first="${r.violations[0].line}"` : ""),
  },
  {
    n: 4,
    cmd: `echo "quoted 'and' $(sub) cmd"`,
    description: `echo "quoted 'and' $(sub) cmd" → exit 0, payload echoed (metacharacter roundtrip)`,
    // Exit 0 alone doesn't prove the payload ran — require the echoed text.
    check: (r) => r.code === 0 && r.stdout.includes("quoted 'and'"),
    detail: (r) =>
      `exit=${r.code} violations=${r.violations.length} stdout=${JSON.stringify(r.stdout)}`,
  },
]

let failures = 0
let skips = 0

function report(mode, a, r) {
  const ok = a.check(r)
  const skipped = a.skip?.(r) ?? false
  console.log(`${ok ? "PASS" : "FAIL"} — mode ${mode} assertion ${a.n}: ${a.description}`)
  console.log(`    ${a.detail(r)}`)
  if (!ok) failures += 1
  if (skipped) skips += 1
}

let hostMode

try {
  // ---- Mode A: default config (apply-seccomp on) ----

  console.log("== mode A: default config (seccomp observer on) ==")
  {
    const a = ASSERTIONS[0]
    const r = await run(a.cmd, newCommandId(), {})
    if (r.code !== 0 && APPLY_SECCOMP_SIGNATURE.test(r.stderr)) {
      // Every wrapped command dies at startup with this signature on hosts
      // whose AppArmor policy capability-strips apply-seccomp's nested user
      // namespace. Expected host outcome, not a probe failure: report it as
      // SKIP, do not count it, and fall through to Mode B.
      console.log(`SKIP — mode A assertion ${a.n}: ${a.description}`)
      console.log(
        `    exit=${r.code} violations=${r.violations.length} — apply-seccomp startup signature: ` +
          `expected host outcome, not counted as a probe failure; falling through to Mode B`,
      )
      hostMode = "no-seccomp"
    } else {
      hostMode = "seccomp"
      report("A", a, r)
      for (const next of ASSERTIONS.slice(1)) {
        const r2 = await run(next.cmd, newCommandId(), {})
        report("A", next, r2)
      }
    }
  }

  // ---- Mode B: allowAllUnixSockets (apply-seccomp skipped entirely) ----
  // Runs on every host; on a Mode-A-clean host it must pass as well (with
  // the same Linux attribution SKIP — Mode B never runs the observer).

  console.log("== mode B: network { allowedDomains: [], deniedDomains: [], allowAllUnixSockets: true } ==")
  for (const a of ASSERTIONS) {
    const r = await run(a.cmd, newCommandId(), { allowAllUnixSockets: true })
    report("B", a, r)
  }
} finally {
  // Clean up: the outside-cwd file must not exist (the write was denied);
  // if the sandbox unexpectedly let it through, remove it and say so. The
  // final reset() tears down whatever the last initialize() left running.
  if (existsSync(PROBE_OUTSIDE)) {
    console.log(`NOTE: ${PROBE_OUTSIDE} exists — the sandboxed touch was NOT blocked`)
    rmSync(PROBE_OUTSIDE, { force: true })
  }
  await SandboxManager.reset()
}

console.log(
  failures === 0
    ? `probe: all counted assertions PASS (host mode: ${hostMode}${skips > 0 ? `; ${skips} attribution SKIP` : ""})`
    : `probe: ${failures} counted assertion failure(s) (host mode: ${hostMode})`,
)
console.log(`HOST-MODE: ${hostMode}`)
process.exitCode = failures === 0 ? 0 : 1
