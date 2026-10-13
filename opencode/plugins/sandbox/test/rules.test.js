import { test } from "node:test"
import assert from "node:assert/strict"
import { wildcardMatch, evaluateRule, predictPermission, createRuleLoader } from "../rules.js"

// Local permission-rule prediction tests. The fixtures are the REALISTIC
// shapes the Task 1 probe observed live (task-1-report.md): the agent
// ruleset (ctx.agent.get({agentID}).data.permissions) opens with the schema
// base policy and ends with the user's config rules ("bash" normalized to
// "shell", specific allows AFTER the `"*": "ask"` wildcard — last match
// wins); an ordinary session carries NO permissions key at all (only an
// explicit session.update ever sets it). The wildcard/evaluate cases pin
// the semantics of ~/forks/opencode packages/core/src/util/wildcard.ts and
// permission.ts:87-101, which rules.js must mirror EXACTLY.
//
// The agent-ruleset cache lives on a LOADER (createRuleLoader), not on the
// module: every test builds its own through `makeLoader()`, which is also
// how policy.js's createGate owns one per plugin instance. Two loaders
// never share a cached agent ruleset (Important 3).

/** A fresh loader — the catch-all for tests that do not exercise the cache
 * itself. */
function makeLoader() {
  return createRuleLoader()
}

/** A counting ctx wrapper: `ctx.agent.get` / `ctx.session.get` invocations
 * are recorded so cache-hit assertions can be exact. */
function countingCtx(inner) {
  const calls = { agent: 0, session: 0 }
  return {
    calls,
    ctx: {
      agent: {
        get: async (input) => {
          calls.agent++
          return inner.agent.get(input)
        },
      },
      session: {
        get: async (input) => {
          calls.session++
          return inner.session.get(input)
        },
      },
    },
  }
}

/** The schema base policy — probe-observed first rules of agent `build`. */
const BASE_POLICY = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "question", resource: "*", effect: "allow" },
]

/** The user's config rules — probe-observed: bare `uptime` asked, `date` /
 * `echo *` / `whoami` allowed live. */
const USER_RULES = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "date", effect: "allow" },
  { action: "shell", resource: "echo *", effect: "allow" },
  { action: "shell", resource: "whoami", effect: "allow" },
  { action: "shell", resource: "git push *", effect: "allow" },
]

/** The full agent ruleset — base policy first, user rules appended. */
const AGENT_RULES = [...BASE_POLICY, ...USER_RULES]

/** An ordinary session — probe-observed keys, note: NO permissions key. */
function makeSession(overrides = {}) {
  return {
    id: "ses_probe0000000000000000000",
    projectID: "prj_probe0000000000000000000",
    model: "opencode-go/step-5-preview-free",
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    time: { created: 0, lastUpdated: 0 },
    title: "probe session",
    location: "/home/user/workspace/agent-kit/.worktrees/sandbox-plugin",
    ...overrides,
  }
}

/** A fake plugin ctx: agent.get answers the probe-verified `{location,
 * data}` wrapper (the ruleset at `data.permissions`); session.get answers
 * the session object directly. */
function makeCtx({ agentRules = AGENT_RULES, session = makeSession() } = {}) {
  return {
    agent: {
      get: async () => ({
        location: { directory: "/home/user/workspace/agent-kit/.worktrees/sandbox-plugin" },
        data: { model: "opencode-go/step-5-preview-free", permissions: agentRules },
      }),
    },
    session: { get: async () => session },
  }
}

test("wildcardMatch: a pattern ending in ' *' matches the bare command and extensions", () => {
  assert.equal(wildcardMatch("git status", "git status *"), true)
  assert.equal(wildcardMatch("git status --short", "git status *"), true)
  assert.equal(wildcardMatch("git statusx", "git status *"), false)
  // The probe-observed user rule, on the probe's drill evidence
  assert.equal(wildcardMatch("echo", "echo *"), true)
  assert.equal(wildcardMatch("echo PROBE-INPUT-MUTATED", "echo *"), true)
})

test("wildcardMatch: '*' matches everything", () => {
  assert.equal(wildcardMatch("uptime", "*"), true)
  assert.equal(wildcardMatch("git push origin main", "*"), true)
  assert.equal(wildcardMatch("", "*"), true)
})

test("wildcardMatch: '?' is exactly one character", () => {
  assert.equal(wildcardMatch("abc", "a?c"), true)
  assert.equal(wildcardMatch("ac", "a?c"), false)
  assert.equal(wildcardMatch("abbc", "a?c"), false)
})

test("wildcardMatch: literal regex metacharacters in patterns are escaped", () => {
  assert.equal(wildcardMatch("axb", "a.b"), false)
  assert.equal(wildcardMatch("a.b", "a.b"), true)
  assert.equal(wildcardMatch("gitttt", "git+"), false)
  assert.equal(wildcardMatch("git+", "git+"), true)
  assert.equal(wildcardMatch("a", "[a]"), false)
  assert.equal(wildcardMatch("[a]", "[a]"), true)
  assert.equal(wildcardMatch("axb", "a|b"), false)
  assert.equal(wildcardMatch("a|b", "a|b"), true)
  assert.equal(wildcardMatch("aa", "a{2}"), false)
  assert.equal(wildcardMatch("a{2}", "a{2}"), true)
})

test("wildcardMatch: backslashes become slashes on input and pattern alike", () => {
  assert.equal(wildcardMatch("C:/Users/user", "C:\\Users\\*"), true)
  assert.equal(wildcardMatch("C:\\Users\\user", "C:/Users/*"), true)
  assert.equal(wildcardMatch("C:\\Users\\user", "C:\\Users\\*"), true)
  // a backslash is a path separator, never a regex escape
  assert.equal(wildcardMatch("a\\.b", "a\\.b"), true)
  assert.equal(wildcardMatch("a/b", "a\\.b"), false)
})

test("wildcardMatch: patterns anchor at both ends", () => {
  assert.equal(wildcardMatch("git status", "git status"), true)
  assert.equal(wildcardMatch("x git status", "git status"), false)
  assert.equal(wildcardMatch("git status extra", "git status"), false)
  assert.equal(wildcardMatch("status", "git status"), false)
})

test("wildcardMatch: dotAll ('s' flag) spans newlines; POSIX stays case-sensitive", () => {
  assert.equal(wildcardMatch("echo hi\nbye", "*"), true)
  assert.equal(wildcardMatch("a\nb", "a?b"), true)
  // core adds 'i' only on win32 — this mirror targets POSIX
  assert.equal(wildcardMatch("GIT STATUS", "git status"), false)
})

test("evaluateRule: the LAST matching rule wins", () => {
  // The realistic set: the base `* *` allow is FIRST, the user's `shell *`
  // ask comes later — bare uptime asks, exactly as the probe observed live.
  assert.equal(evaluateRule("shell", "uptime", AGENT_RULES), "ask")
  assert.equal(evaluateRule("shell", "date", AGENT_RULES), "allow")
  // A later same-pattern rule overrides an earlier one
  assert.equal(
    evaluateRule("shell", "uptime", [...AGENT_RULES, { action: "shell", resource: "uptime", effect: "deny" }]),
    "deny",
  )
  // Base policy alone: `read *.env` ask overrides the earlier `* *` allow
  assert.equal(evaluateRule("read", "prod.env", BASE_POLICY), "ask")
  assert.equal(evaluateRule("read", "prod.env.local", BASE_POLICY), "ask")
})

test("evaluateRule: no matching rule → ask (core's default)", () => {
  assert.equal(evaluateRule("shell", "uptime", []), "ask")
  // the action must match per rule — shell-only rules never answer an edit
  assert.equal(evaluateRule("edit", "src/index.ts", USER_RULES), "ask")
  assert.equal(evaluateRule("shell", "uptime", [{ action: "read", resource: "*", effect: "allow" }]), "ask")
})

test("evaluateRule: deny/allow/ask rules answer by their effect; action wildcards match any action", () => {
  assert.equal(evaluateRule("shell", "rm -rf /", [{ action: "shell", resource: "rm -rf *", effect: "deny" }]), "deny")
  assert.equal(
    evaluateRule("shell", "git push origin main", [{ action: "shell", resource: "git push *", effect: "allow" }]),
    "allow",
  )
  assert.equal(evaluateRule("shell", "make test", [{ action: "shell", resource: "*", effect: "ask" }]), "ask")
  assert.equal(evaluateRule("edit", "prod.env", [{ action: "*", resource: "*.env", effect: "ask" }]), "ask")
  assert.equal(evaluateRule("shell", "prod.json", [{ action: "*", resource: "*.env", effect: "ask" }]), "ask")
})

test("predictPermission: reproduces the probe's live outcomes on the realistic ruleset", () => {
  // Probe-observed live effects: date / echo * / whoami allowed, bare
  // uptime and `srt -- uptime` asked; git push * is the user's allow rule.
  assert.equal(predictPermission({ rules: AGENT_RULES, action: "shell", command: "date" }), "allow")
  assert.equal(predictPermission({ rules: AGENT_RULES, action: "shell", command: "echo PROBE-INPUT-MUTATED" }), "allow")
  assert.equal(predictPermission({ rules: AGENT_RULES, action: "shell", command: "whoami" }), "allow")
  assert.equal(predictPermission({ rules: AGENT_RULES, action: "shell", command: "uptime" }), "ask")
  assert.equal(predictPermission({ rules: AGENT_RULES, action: "shell", command: "srt -- uptime" }), "ask")
  assert.equal(predictPermission({ rules: AGENT_RULES, action: "shell", command: "git push origin main" }), "allow")
})

test("predictPermission: deny/allow/ask propagation", () => {
  const rules = [...AGENT_RULES, { action: "shell", resource: "curl *", effect: "deny" }]
  assert.equal(predictPermission({ rules, action: "shell", command: "curl https://example.com" }), "deny")
  assert.equal(predictPermission({ rules, action: "shell", command: "uptime" }), "ask")
  // base policy alone: `* *` allow answers everything
  assert.equal(predictPermission({ rules: BASE_POLICY, action: "shell", command: "uptime" }), "allow")
  // no rules at all → core's default ask
  assert.equal(predictPermission({ rules: [], action: "shell", command: "uptime" }), "ask")
})

test("loadRules: agent rules first, session rules appended — a session rule overrides a same-pattern agent rule", async () => {
  const session = makeSession({ permissions: [{ action: "shell", resource: "git push *", effect: "deny" }] })
  const calls = { agent: [], session: [] }
  const ctx = {
    agent: {
      get: async (input) => {
        calls.agent.push(input)
        return { location: { directory: "/w" }, data: { model: "m", permissions: AGENT_RULES } }
      },
    },
    session: {
      get: async (input) => {
        calls.session.push(input)
        return session
      },
    },
  }
  const { loadRules } = makeLoader()
  const result = await loadRules(ctx, "ses_merge", "build")
  assert.equal(result.ok, true)
  // exact call shapes
  assert.deepEqual(calls.agent, [{ agentID: "build" }])
  assert.deepEqual(calls.session, [{ sessionID: "ses_merge" }])
  // the merged ruleset: the whole agent set, then the session rule
  assert.equal(result.rules.length, AGENT_RULES.length + 1)
  assert.deepEqual(result.rules[AGENT_RULES.length], { action: "shell", resource: "git push *", effect: "deny" })
  // the agent's `git push *` allow sits earlier; the session deny is last,
  // and last match wins → the push the agent rules allow is now denied
  assert.equal(predictPermission({ rules: result.rules, action: "shell", command: "git push origin main" }), "deny")
})

test("loadRules: an ordinary session (permissions absent) yields the agent rules alone", async () => {
  const ctx = makeCtx({ session: makeSession() })
  const { loadRules } = makeLoader()
  const result = await loadRules(ctx, "ses_plain", "general")
  assert.equal(result.ok, true)
  assert.deepEqual(result.rules, AGENT_RULES)
  assert.equal(predictPermission({ rules: result.rules, action: "shell", command: "uptime" }), "ask")
})

test("loadRules: an agent with no permissions array resolves to core's default-deny ruleset", async () => {
  const noPermissions = {
    agent: { get: async () => ({ location: { directory: "/w" }, data: { model: "opencode-go/step-5-preview-free" } }) },
    session: { get: async () => makeSession() },
  }
  const { loadRules } = makeLoader()
  const result = await loadRules(noPermissions, "ses_default", "review")
  assert.equal(result.ok, true)
  assert.deepEqual(result.rules, [{ action: "*", resource: "*", effect: "deny" }])
  assert.equal(predictPermission({ rules: result.rules, action: "shell", command: "uptime" }), "deny")
  // no `data` at all — same default (core's `agent?.permissions ?? missing`)
  const bare = { agent: { get: async () => ({ location: { directory: "/w" } }) }, session: { get: async () => makeSession() } }
  const bareResult = await loadRules(bare, "ses_default_bare", "plan")
  assert.equal(bareResult.ok, true)
  assert.deepEqual(bareResult.rules, [{ action: "*", resource: "*", effect: "deny" }])
})

test("loadRules: agent rules are cached per agentID — a second call with a different ctx reuses them", async () => {
  const markerRule = { action: "shell", resource: "probe-cache-marker *", effect: "allow" }
  const ctxA = makeCtx({ agentRules: [...AGENT_RULES, markerRule] })
  const { loadRules } = makeLoader() // ONE loader: the cache is the loader's
  const first = await loadRules(ctxA, "ses_cache_a", "sonnet")
  assert.equal(first.ok, true)
  assert.ok(first.rules.some((r) => r.resource === "probe-cache-marker *"))

  // A different ctx whose agent.get THROWS if called — the cache must
  // supply the agent rules; the session is still fetched from THIS ctx.
  const ctxB = {
    agent: {
      get: async () => {
        throw new Error("agent.get must not be called on a cache hit")
      },
    },
    session: {
      get: async () => makeSession({ permissions: [{ action: "shell", resource: "session-fresh *", effect: "ask" }] }),
    },
  }
  const second = await loadRules(ctxB, "ses_cache_b", "sonnet")
  assert.equal(second.ok, true)
  assert.ok(second.rules.some((r) => r.resource === "probe-cache-marker *")) // cached agent rules
  assert.ok(second.rules.some((r) => r.resource === "session-fresh *")) // session stays per-call
  assert.equal(second.rules.length, AGENT_RULES.length + 2)
})

test("createRuleLoader: a FRESH loader starts with a cold cache even when another loader already warmed that agentID", async () => {
  const warm = countingCtx(makeCtx({ agentRules: [...AGENT_RULES, { action: "shell", resource: "warm *", effect: "allow" }] }))
  const cold = countingCtx(makeCtx({ agentRules: [...AGENT_RULES, { action: "shell", resource: "cold *", effect: "allow" }] }))

  const loaderA = makeLoader()
  assert.equal((await loaderA.loadRules(warm.ctx, "ses_cold_1", "shared")).ok, true)
  assert.equal(warm.calls.agent, 1)

  // A second loader is a NEW plugin instance (a config edit rebuilds the
  // plugin in the SAME process): its cache is cold, so it re-reads the
  // agent rules from its own ctx — the stale ruleset cannot survive.
  const loaderB = makeLoader()
  const result = await loaderB.loadRules(cold.ctx, "ses_cold_2", "shared")
  assert.equal(cold.calls.agent, 1) // the agent.get actually ran again
  assert.ok(result.rules.some((r) => r.resource === "cold *"))
  assert.ok(!result.rules.some((r) => r.resource === "warm *"))

  // And the first loader's own cache still holds ITS ruleset (its second
  // call is a hit — warm's counter stays at 1).
  const again = await loaderA.loadRules(warm.ctx, "ses_cold_3", "shared")
  assert.equal(warm.calls.agent, 1)
  assert.ok(again.rules.some((r) => r.resource === "warm *"))
})

test("createRuleLoader: two loaders do not share cached agent rules (module scope is gone)", async () => {
  const ctxA = makeCtx({ agentRules: [{ action: "shell", resource: "opus-only *", effect: "allow" }] })
  const ctxB = makeCtx({ agentRules: [{ action: "shell", resource: "code-only *", effect: "allow" }] })
  const loaderA = makeLoader()
  const loaderB = makeLoader()
  const a = await loaderA.loadRules(ctxA, "s1", "same-agent")
  const b = await loaderB.loadRules(ctxB, "s2", "same-agent") // the SAME agentID
  assert.ok(a.rules.some((r) => r.resource === "opus-only *"))
  assert.ok(b.rules.some((r) => r.resource === "code-only *"))
  assert.ok(!a.rules.some((r) => r.resource === "code-only *"))
  assert.ok(!b.rules.some((r) => r.resource === "opus-only *"))
})

test("loadRules: the cache is keyed per agentID (separate agents, separate rulesets)", async () => {
  const { loadRules } = makeLoader()
  const a = await loadRules(
    makeCtx({ agentRules: [{ action: "shell", resource: "opus-only *", effect: "allow" }] }),
    "ses_key_a",
    "opus",
  )
  const b = await loadRules(
    makeCtx({ agentRules: [{ action: "shell", resource: "code-only *", effect: "allow" }] }),
    "ses_key_b",
    "code",
  )
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.ok(a.rules.some((r) => r.resource === "opus-only *"))
  assert.ok(b.rules.some((r) => r.resource === "code-only *"))
  assert.ok(!a.rules.some((r) => r.resource === "code-only *"))
  assert.ok(!b.rules.some((r) => r.resource === "opus-only *"))
})

test("loadRules: a throwing ctx → { ok: false, reason }; never rejects", async () => {
  const { loadRules } = makeLoader()
  // agent.get rejects (async throw)
  const agentRejects = {
    agent: {
      get: async () => {
        throw new Error("agent.get exploded")
      },
    },
    session: { get: async () => makeSession() },
  }
  const r1 = await loadRules(agentRejects, "ses_throw_1", "debug")
  assert.equal(r1.ok, false)
  assert.equal(typeof r1.reason, "string")
  assert.ok(r1.reason.length > 0)

  // session.get rejects — the whole load fails; the agent stays uncached
  const sessionRejects = {
    agent: { get: async () => ({ location: {}, data: { permissions: AGENT_RULES } }) },
    session: {
      get: async () => {
        throw new Error("session.get exploded")
      },
    },
  }
  const r2 = await loadRules(sessionRejects, "ses_throw_2", "summarize")
  assert.equal(r2.ok, false)
  assert.equal(typeof r2.reason, "string")

  // synchronous throws and missing ctx namespaces are throws too
  const syncThrow = {
    agent: {
      get: () => {
        throw new Error("agent.get threw synchronously")
      },
    },
    session: { get: () => makeSession() },
  }
  const r3 = await loadRules(syncThrow, "ses_throw_3", "title")
  assert.equal(r3.ok, false)

  const noAgentNamespace = { session: { get: async () => makeSession() } }
  const r4 = await loadRules(noAgentNamespace, "ses_throw_4", "issue")
  assert.equal(r4.ok, false)

  // a null ctx throws at the first property access — still {ok:false}
  const r5 = await loadRules(null, "ses_throw_5", "any")
  assert.equal(r5.ok, false)
  assert.equal(typeof r5.reason, "string")

  // the never-rejects contract, explicit
  await assert.doesNotReject(loadRules(agentRejects, "ses_throw_6", "explore"))
})