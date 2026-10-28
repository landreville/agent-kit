import { test } from "node:test"
import assert from "node:assert/strict"
import { segmentCommand } from "../segments.js"

// The conservative segmenter's corpus: every accept shape the gate is
// allowed to wrap, every reject shape, the trimming and separator rules,
// and the totality contract. Task 4's scanner fixtures pin this corpus
// against core's real shell scanner — do not weaken or drop a case.

/** Shorthand: segment or reject, with a default-shaped failure object. */
function seg(command) {
  return segmentCommand(command)
}

test("splits top-level operators: pipe, &&, ||, ;, newline", () => {
  assert.deepEqual(seg("python3 x.py 2>&1 | tail -5"), {
    ok: true,
    segments: ["python3 x.py 2>&1", "tail -5"],
  })
  assert.deepEqual(seg("set -e\ngit status --short\ngit add docs/x"), {
    ok: true,
    segments: ["set -e", "git status --short", "git add docs/x"],
  })
  assert.deepEqual(seg("make && make install"), {
    ok: true,
    segments: ["make", "make install"],
  })
  assert.deepEqual(seg("a || b; c | d"), {
    ok: true,
    segments: ["a", "b", "c", "d"],
  })
})

test("quoted operators stay inside ONE segment", () => {
  assert.deepEqual(seg('git commit -q -m "Add plan for a && b SVG"'), {
    ok: true,
    segments: ['git commit -q -m "Add plan for a && b SVG"'],
  })
  assert.deepEqual(seg("echo 'a|b'"), {
    ok: true,
    segments: ["echo 'a|b'"],
  })
  // A " quoted inside single quotes is literal.
  assert.deepEqual(seg("echo '\"hi\"'"), {
    ok: true,
    segments: ["echo '\"hi\"'"],
  })
  // Inside '…' EVERY byte is literal: a trailing `\'` closes nothing —
  // only `'` does (finding: `\` must not escape inside single quotes).
  assert.deepEqual(seg("echo 'a\\'"), {
    ok: true,
    segments: ["echo 'a\\'"],
  })
})

test("backslash-escaped ; and | are literal (no split)", () => {
  assert.deepEqual(seg("echo a\\;b"), {
    ok: true,
    segments: ["echo a\\;b"],
  })
  assert.deepEqual(seg("echo x\\|y"), {
    ok: true,
    segments: ["echo x\\|y"],
  })
})

test("trailing newline tolerated; blank inner lines dropped; segments trimmed", () => {
  assert.deepEqual(seg("git log\n"), {
    ok: true,
    segments: ["git log"],
  })
  assert.deepEqual(seg("git log\n\n\ngit status\n"), {
    ok: true,
    segments: ["git log", "git status"],
  })
  assert.deepEqual(seg("git log \t\n\t\ngit status\t"), {
    ok: true,
    segments: ["git log", "git status"],
  })
  assert.deepEqual(seg("a ; \t b"), {
    ok: true,
    segments: ["a", "b"],
  })
})

test("accepts fd-dup redirects (not backgrounding)", () => {
  assert.deepEqual(seg("python3 x.py 2>&1 | tail"), {
    ok: true,
    segments: ["python3 x.py 2>&1", "tail"],
  })
  assert.deepEqual(seg("cmd >&2"), {
    ok: true,
    segments: ["cmd >&2"],
  })
  assert.deepEqual(seg("cmd <&0"), {
    ok: true,
    segments: ["cmd <&0"],
  })
})

test("rejects with the exact reason strings", () => {
  const rejects = [
    ["( cd /tmp && pwd )", "subshell"],
    ["echo $(date)", "command-substitution"],
    ["echo `date`", "command-substitution"],
    ["echo 'unterminated", "unbalanced-quote"],
    ["cat <<EOF", "heredoc"],
    ["sleep 5 &", "background-ampersand"],
    ["python a &> /dev/null", "redirect-and"],
    ["echo x >&& y", "redirect-and"], // a dup's `&` followed by another `&`
    ["cat <&> f", "redirect-and"], // a dup's `&` followed by another `>`
    ["cmd |& cat", "pipe-stderr"],
    ["echo $'x'", "ansi-quote"],
    ["ls && echo # done", "comment"],
    ["echo \"unterminated", "unbalanced-quote"],
    ["true ;; false", "empty-segment"],
    ["true && ", "empty-segment"],
  ]
  for (const [command, reason] of rejects) {
    assert.deepEqual(segmentCommand(command), { ok: false, reason },
      `input ${JSON.stringify(command)}`)
  }
})

test("\\r is a separator like \\n; lone trailing \\r trimmed", () => {
  assert.deepEqual(seg("git log\r\ngit status"), {
    ok: true,
    segments: ["git log", "git status"],
  })
  assert.deepEqual(seg("git log\r"), {
    ok: true,
    segments: ["git log"],
  })
  assert.deepEqual(seg("git log\r\r\n\rgit status\r"), {
    ok: true,
    segments: ["git log", "git status"],
  })
})

test("empty input rejects empty-input", () => {
  assert.deepEqual(seg(""), { ok: false, reason: "empty-input" })
  assert.deepEqual(seg("   "), { ok: false, reason: "empty-input" })
  assert.deepEqual(seg("\n\n"), { ok: false, reason: "empty-input" })
})

test("non-string input rejects no-command", () => {
  assert.deepEqual(segmentCommand(undefined), { ok: false, reason: "no-command" })
  assert.deepEqual(segmentCommand(null), { ok: false, reason: "no-command" })
  assert.deepEqual(segmentCommand(42), { ok: false, reason: "no-command" })
})

test("totality: never throws on hostile or huge input", () => {
  assert.deepEqual(seg("\x00"), { ok: true, segments: ["\x00"] })
  assert.deepEqual(seg("\ud800"), { ok: true, segments: ["\ud800"] })
  const tenK = "a".repeat(10000)
  assert.deepEqual(seg(tenK), { ok: true, segments: [tenK] })
  const big = "git status\n" + "x ".repeat(10000) + "\nmake test"
  const result = seg(big)
  assert.equal(result.ok, true)
  assert.equal(result.segments[0], "git status")
  assert.equal(result.segments[2], "make test")
})

test("rejects compound-command keywords core's scanner looks through", () => {
  // core asserts `rm -rf x` for these; a slice like `then rm -rf x` would
  // never match a `rm *` deny, so the shape must not be accepted.
  for (const input of [
    "if true; then rm -rf x; fi",
    "{ rm -rf x; }",
    "for f in a b; do rm $f; done",
    "while false; do rm x; done",
    "until false; do rm x; done",
    "select x in a; do rm x; done",
    "function f { rm x; }",
    "! rm x",
    "if true\nthen rm x\nfi",
  ]) {
    assert.deepEqual(seg(input), { ok: false, reason: "compound-keyword" }, input)
  }
  // a keyword word inside a segment's args stays ordinary text
  assert.deepEqual(seg("echo then && git log"), { ok: true, segments: ["echo then", "git log"] })
})

test("`>|` is a clobber redirect, not a pipe", () => {
  assert.deepEqual(seg("echo x >| out && git log"), { ok: true, segments: ["echo x >| out", "git log"] })
})
