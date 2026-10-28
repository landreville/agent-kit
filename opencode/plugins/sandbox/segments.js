/**
 * The conservative command segmenter for the OpenCode `sandbox` plugin —
 * the single parser the whole compound-command feature shares. Task 4's
 * philosophy in one line: the gate may only wrap what it segmented
 * faithfully, so this module is TOTAL (never throws, on any input — tokens
 * like `\x00` and lone surrogates included), strictly fail-closed, and its
 * accepted segment texts are trimmed slices of the original input between
 * top-level operators, the same slices OpenCode core's shell scanner
 * asserts as resources.
 *
 * ANTI-DRIFT CONTRACT (spec §Design, "Anti-drift contract"): the
 * accept-set here is deliberately NARROWER than the scanner's grammar.
 * Security-critical direction — for every accepted shape, the segment
 * array must COVER core's shell-resource array: every resource the
 * scanner would assert must appear among the segments, because a wrapped
 * command's deny check only sees the single wrapped resource and this
 * prediction is the only line of defense. Anything that makes faithful
 * prediction impossible is REJECTED (`ok: false`) and keeps today's
 * behavior exactly — the normal permission flow, never wrapped:
 * subshells `( … )`, command substitution `$( … )` / backticks, process
 * substitution `<(` / `>(`, heredocs `<<`, background `&`, the bashisms
 * `&>` / `>&&` / `<&>` / `|&`, ANSI-C quoting `$'`, segments led by a
 * compound-command keyword (`if`/`then`/`do`/`{`/`!`/…), unquoted comments
 * `#`, unbalanced quotes, and empty segments at an operator boundary
 * (`a ;; b`, trailing `&&`). Blank lines between newline-separated
 * commands are DROPPED, not rejected (a script ending in a newline is
 * normal; core produces no resource for a blank line).
 *
 * ELISION PROJECTION (spec §Design, "Elision projection"): core drops some
 * segments from resources — declaration commands (`export`/`unset`/…)
 * produce none, and the cwd set (`cd`/`pushd`/…) routes into
 * `directories`. Those families are still emitted here as ordinary
 * segments; prediction evaluates them. Over-predicting a dropped segment
 * as `ask` only contributes toward wrapping (the sandbox floor contains
 * it — the same containment a wrapped simple `cd x` gets today), and
 * predicting `deny` on one only skips = status quo. So emitting them is
 * the safe direction on both sides.
 *
 * Implementation: a single linear scan with a character state machine —
 * quote states (`'…'` literal; `"…"` with backslash escapes; unquoted
 * where a backslash escapes the next char, INCLUDING a would-be
 * separator), and at TOP-LEVEL quote-state only the split points
 * (`&&`/`||`/`|`/`;`/newline/`\r` — the operator kind is discarded) and
 * the reject shapes above. fd-dup redirects (`2>&1`, `>&2`, `<&0`) are the
 * legal `&`; `&` handling scans its raw neighbors. Every rejection reason
 * is a short lowercase string for LOGS ONLY — rejects never reach the
 * user (an unparseable shape prompts exactly like today). No
 * dependencies; the only export is `segmentCommand`.
 */

const OP = "operator" // separator kind of &&, ||, |, ;
const NEWLINE = "newline" // separator kind of \n, \r — and of either
// string boundary, whose blank candidate must be droppable (leading or
// trailing newline) rather than rejected.

/** Trimmed-slice emptiness test for a whole input and for candidates. */
function isBlank(text) {
  return text.trim() === ""
}

/** Shell reserved words that open, continue or close a compound command
 * (and the `!` pipeline negation). Core's scanner looks THROUGH them —
 * `if true; then rm x; fi` asserts `true` and `rm x` — while a naive
 * slice would emit `then rm x`, which no `rm *` rule matches. A segment
 * led by one of these is rejected so the accepted segments always cover
 * core's resources (anti-drift contract). */
const COMPOUND_WORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "select", "do", "done",
  "case", "esac", "function", "{", "}", "!",
])

export function segmentCommand(command) {
  if (typeof command !== "string") {
    return { ok: false, reason: "no-command" }
  }
  if (isBlank(command)) {
    return { ok: false, reason: "empty-input" }
  }

  const segments = []
  let start = 0 // candidate slice [start, i) — the next split point
  let leftSep = NEWLINE // separator kind immediately LEFT of the candidate
  let quote = null // open quote char, or null at top level

  // Close the candidate against the separator kind that now follows it.
  // A blank candidate at ANY operator boundary — leading `&&`, trailing
  // `&&`, `a ;; b`, the `; ;` in `true ;; false` — rejects; a blank
  // candidate bounded by newlines only is a blank line: dropped.
  // Returns the rejection reason, or null on success.
  function closeCandidate(rightSep, end) {
    const text = command.slice(start, end).trim() // trimmed raw slice
    if (text === "") {
      if (leftSep === OP || rightSep === OP) {
        return "empty-segment"
      }
      return null
    }
    if (COMPOUND_WORDS.has(text.split(/\s+/)[0])) {
      return "compound-keyword"
    }
    segments.push(text)
    return null
  }

  for (let i = 0; i < command.length; ) {
    const c = command[i]
    const next = i + 1 < command.length ? command[i + 1] : ""

    if (quote === "'") {
      if (c === "'") {
        quote = null
      }
      // Inside '…' EVERY byte is literal — only `'` closes; a backslash
      // escapes nothing here, so `echo 'a\'` closes at its own `'`.
      i++
      continue
    }
    if (quote === '"') {
      if (c === "\\") {
        i += 2 // backslash escapes the next char inside "…"; hops at EOI
        continue
      }
      if (c === '"') {
        quote = null
      }
      i++
      continue
    }
    if (c === "\\") {
      i += 2 // unquoted: escapes the NEXT char — a separator escaped here
      continue // is literal, so the split operator pair is skipped whole
    }
    if (c === "'" || c === '"') {
      quote = c
      i++
      continue
    }
    if (c === "$") {
      if (next === "(") {
        return { ok: false, reason: "command-substitution" }
      }
      if (next === "'") {
        return { ok: false, reason: "ansi-quote" }
      }
      i++ // `$VAR`, `${…}`, `$/` — ordinary in-word characters
      continue
    }
    if (c === "`") {
      return { ok: false, reason: "command-substitution" }
    }
    if (c === "(" || c === ")") {
      return { ok: false, reason: "subshell" }
    }
    if (c === "#") {
      return { ok: false, reason: "comment" } // unquoted comment start
    }
    if (c === "<" || c === ">") {
      if (next === "<") {
        return { ok: false, reason: "heredoc" }
      }
      if (next === "(") {
        return { ok: false, reason: "process-substitution" }
      }
      if (c === ">" && next === "|") {
        i += 2 // `>|` clobber redirect — its `|` is not a pipe
        continue
      }
      i++ // redirect chars are otherwise ordinary segment text
      continue
    }
    if (c === "&") {
      const prev = i > 0 ? command[i - 1] : ""
      if (next === "&") {
        // `&&` operator — EXCEPT the dup context: after `>`/`<` the pair
        // `>&&`/`<&>` is the redirect-and shape (rule 3), rejected here
        // BEFORE the `&&` split could ever consume it.
        if (prev === ">" || prev === "<") {
          return { ok: false, reason: "redirect-and" }
        }
        // Split on `&&`, consume both chars.
        const reject = closeCandidate(OP, i)
        if (reject) return { ok: false, reason: reject }
        leftSep = OP
        start = i + 2
        i += 2
        continue
      }
      if (next === ">") {
        // The `&>` bashism — which also catches the dup's `&` followed
        // by another `>` (`<&>`).
        return { ok: false, reason: "redirect-and" }
      }
      if (prev === "|") {
        return { ok: false, reason: "pipe-stderr" } // the `|&` bashism
      }
      if (prev === ">" || prev === "<") {
        i++ // fd-dup `>&`/`<&` (e.g. `2>&1`, `>&2`, `<&0`) — the ONLY legal
        continue // `&` after a redirect char; anything else rejects above
      }
      return { ok: false, reason: "background-ampersand" }
    }
    if (c === "|" || c === ";") {
      const size = c === "|" && next === "|" ? 2 : 1 // `||` one operator
      const reject = closeCandidate(OP, i)
      if (reject) return { ok: false, reason: reject }
      leftSep = OP
      start = i + size
      i += size
      continue
    }
    if (c === "\n" || c === "\r") {
      const reject = closeCandidate(NEWLINE, i)
      if (reject) return { ok: false, reason: reject }
      leftSep = NEWLINE
      start = i + 1
      i++
      continue
    }
    i++ // plain word character (NUL, surrogates included: totality)
  }

  if (quote !== null) {
    return { ok: false, reason: "unbalanced-quote" }
  }
  const reject = closeCandidate(NEWLINE, command.length) // EOI ≡ newline: a
  // blank tail is a tolerated trailing newline, an operator-left blank
  // (`true && `) is already `empty-segment`.
  if (reject) return { ok: false, reason: reject }
  return { ok: true, segments }
}
