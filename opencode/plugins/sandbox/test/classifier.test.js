import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPrompt, parseVerdict, createClassifier } from "../classifier.js"

// Every model call goes through an injected fake `ctx.generate` — these
// tests never call a real model.

const POLICY = {
  allowedDomains: ["registry.npmjs.org", "api.github.com"],
  writeRoots: ["/home/user/repo", "/tmp"],
  deniedReads: ["~/.ssh", "~/.aws"],
}

const ENABLED = { enabled: true, providerID: "litellm", id: "jev-1.13" }

const DISABLED = { enabled: false, providerID: "litellm", id: "jev-1.13" }

/** A fake `ctx.generate`: records every call's input and answers from a
 * fixed value or a function of (input, call number); an Error answer
 * rejects the promise. */
function makeCtx(answer) {
  const calls = []
  const ctx = {
    generate: {
      text: (input) => {
        calls.push(input)
        return new Promise((resolve, reject) => {
          const value = typeof answer === "function" ? answer(input, calls.length) : answer
          if (value instanceof Error) reject(value)
          else resolve({ text: value })
        })
      },
    },
  }
  return { ctx, calls }
}

test("buildPrompt embeds the command and every policy list", () => {
  const prompt = buildPrompt("npm install left-pad", POLICY)
  assert.ok(prompt.includes("npm install left-pad"))
  assert.ok(prompt.includes("registry.npmjs.org"))
  assert.ok(prompt.includes("api.github.com"))
  assert.ok(prompt.includes("/home/user/repo"))
  assert.ok(prompt.includes("/tmp"))
  assert.ok(prompt.includes("~/.ssh"))
  assert.ok(prompt.includes("~/.aws"))
  assert.ok(prompt.includes("would this command SUCCEED inside that sandbox"))
})

test("buildPrompt says none when allowedDomains is empty", () => {
  const prompt = buildPrompt("ls -la", {
    allowedDomains: [],
    writeRoots: ["/tmp"],
    deniedReads: ["~/.ssh"],
  })
  assert.ok(prompt.includes("none"))
  assert.ok(prompt.includes("/tmp"))
  assert.ok(prompt.includes("~/.ssh"))
})

test("parseVerdict fixtures", () => {
  assert.deepEqual(parseVerdict("SAFE"), { verdict: "SAFE" })
  // Case-insensitive UNSAFE — the approved spec says "first non-empty line,
  // case-insensitive prefix" and the plan's interface says /^UNSAFE\b/i.
  // NOTE: the plan's Task-4 fixture list instead reads `"unsafe"` → SAFE,
  // contradicting both — resolved toward case-insensitive here (see
  // task-4-report.md, Concern 1).
  assert.deepEqual(parseVerdict("unsafe"), { verdict: "UNSAFE" })
  assert.deepEqual(parseVerdict("UNSAFE: needs registry.npmjs.org"), {
    verdict: "UNSAFE",
    reason: "needs registry.npmjs.org",
  })
  assert.deepEqual(parseVerdict("I believe it is fine."), { verdict: "SAFE" })
})

test("parseVerdict takes the first non-empty line; tolerates case and separators", () => {
  assert.deepEqual(parseVerdict("\n\n  SAFE  \nextra line"), { verdict: "SAFE" })
  assert.deepEqual(parseVerdict("  UNSAFE: needs registry.npmjs.org  \nwhy?"), {
    verdict: "UNSAFE",
    reason: "needs registry.npmjs.org",
  })
  // No colon: the rest of the line after the keyword is the reason.
  assert.deepEqual(parseVerdict("UNSAFE needs network"), {
    verdict: "UNSAFE",
    reason: "needs network",
  })
  // Bare keyword: UNSAFE without a reason.
  assert.deepEqual(parseVerdict("UNSAFE:"), { verdict: "UNSAFE" })
  // Empty or whitespace-only answer: garbage → SAFE.
  assert.deepEqual(parseVerdict(""), { verdict: "SAFE" })
  assert.deepEqual(parseVerdict("   \n \n"), { verdict: "SAFE" })
  assert.deepEqual(parseVerdict(undefined), { verdict: "SAFE" })
})

test("disabled classifier returns SAFE without calling generate", async () => {
  const { ctx, calls } = makeCtx("UNSAFE: needs network")
  const classifier = createClassifier(ctx, DISABLED)
  assert.deepEqual(await classifier.classify("curl https://example.com", POLICY), { verdict: "SAFE" })
  assert.equal(calls.length, 0)
})

test("classify calls generate with the resolved model and the built prompt", async () => {
  const { ctx, calls } = makeCtx("SAFE")
  const classifier = createClassifier(ctx, ENABLED)
  assert.deepEqual(await classifier.classify("npm install left-pad", POLICY), { verdict: "SAFE" })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].model, { providerID: "litellm", id: "jev-1.13" })
  assert.equal(calls[0].prompt, buildPrompt("npm install left-pad", POLICY))
})

test("classify flows an UNSAFE verdict and reason through", async () => {
  const { ctx } = makeCtx("UNSAFE: needs registry.npmjs.org\nit will fail in the sandbox")
  const classifier = createClassifier(ctx, ENABLED)
  assert.deepEqual(await classifier.classify("npm install left-pad", POLICY), {
    verdict: "UNSAFE",
    reason: "needs registry.npmjs.org",
  })
})

test("generate rejecting → SAFE, never a throw (fail toward the sandbox attempt)", async () => {
  const { ctx, calls } = makeCtx(new Error("gateway down"))
  const logs = []
  const classifier = createClassifier(ctx, ENABLED, { log: (m) => logs.push(m) })
  assert.deepEqual(await classifier.classify("curl https://example.com", POLICY), { verdict: "SAFE" })
  assert.equal(calls.length, 1)
  assert.ok(logs.some((m) => m.includes("classifier")))
})

test("garbage and empty answers → SAFE", async () => {
  const garbage = createClassifier(makeCtx("I believe it is fine.").ctx, ENABLED)
  assert.deepEqual(await garbage.classify("ls -la", POLICY), { verdict: "SAFE" })
  const empty = createClassifier(makeCtx("").ctx, ENABLED)
  assert.deepEqual(await empty.classify("ls -la", POLICY), { verdict: "SAFE" })
})

test("second classify of the same command → exactly one generate call", async () => {
  const { ctx, calls } = makeCtx("UNSAFE: needs registry.npmjs.org")
  const classifier = createClassifier(ctx, ENABLED)
  const first = await classifier.classify("npm install left-pad", POLICY)
  // The cache is keyed by command text only — a different policy for the
  // same command still returns the cached verdict.
  const second = await classifier.classify("npm install left-pad", {
    allowedDomains: ["example.com"],
    writeRoots: ["/elsewhere"],
    deniedReads: [],
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(second, first)
  await classifier.classify("curl https://example.com", POLICY)
  assert.equal(calls.length, 2)
})

test("a failed generate is not cached: a recovered gateway is re-asked", async () => {
  const { ctx, calls } = makeCtx((input, n) =>
    n === 1 ? new Error("gateway down") : "UNSAFE: needs network",
  )
  const classifier = createClassifier(ctx, ENABLED)
  assert.deepEqual(await classifier.classify("curl https://example.com", POLICY), { verdict: "SAFE" })
  assert.deepEqual(await classifier.classify("curl https://example.com", POLICY), {
    verdict: "UNSAFE",
    reason: "needs network",
  })
  assert.equal(calls.length, 2)
})

test("a re-created classifier re-asks (the plugin re-loads on config change)", async () => {
  const a = makeCtx("SAFE")
  const b = makeCtx("UNSAFE: needs network")
  const first = createClassifier(a.ctx, ENABLED)
  const second = createClassifier(b.ctx, ENABLED)
  await first.classify("make test", POLICY)
  await second.classify("make test", POLICY)
  assert.equal(a.calls.length, 1)
  assert.equal(b.calls.length, 1)
})

test("never throws: a sync-throwing generate and a ctx without generate", async () => {
  const boom = {
    generate: {
      text() {
        throw new Error("sync boom")
      },
    },
  }
  const classifier = createClassifier(boom, ENABLED)
  assert.deepEqual(await classifier.classify("ls", POLICY), { verdict: "SAFE" })
  const bare = createClassifier({}, ENABLED)
  assert.deepEqual(await bare.classify("ls", POLICY), { verdict: "SAFE" })
})
