import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime"
import { resolveOptions, buildBaseConfig, validateBaseConfig, fallbackBaseConfig, buildCustomConfig, isSrtInvocation, matchesExcludedCommand, resolveGitCommonDir } from "../config.js"

test("defaults deny-read covers sensitive paths and deny all network", () => {
  const opts = resolveOptions({})
  assert.ok(opts.filesystem.denyRead.includes("~/.ssh"))
  assert.deepEqual(opts.network.allowedDomains, [])
  assert.equal(opts.classifier.enabled, false)
  assert.equal(opts.install, "ask")
})

test("requireSeccomp defaults to false; only literal true resolves true", () => {
  assert.equal(resolveOptions({}).requireSeccomp, false)
  assert.equal(resolveOptions({ requireSeccomp: true }).requireSeccomp, true)
  assert.equal(resolveOptions({ requireSeccomp: false }).requireSeccomp, false)
  assert.equal(resolveOptions({ requireSeccomp: "true" }).requireSeccomp, false)
  assert.equal(resolveOptions({ requireSeccomp: 1 }).requireSeccomp, false)
  assert.equal(resolveOptions(null).requireSeccomp, false)
})

test("extras extend, never replace, the safe defaults", () => {
  const opts = resolveOptions({ filesystem: { denyRead: ["~/extra"], allowWrite: ["/data"], denyWrite: ["/keep"] } })
  assert.ok(opts.filesystem.denyRead.includes("~/.ssh"))
  assert.deepEqual(opts.filesystem.allowWrite, ["/data"])
})

test("base config validates against the library schema (injected)", () => {
  const result = validateBaseConfig(buildBaseConfig(resolveOptions({})), SandboxRuntimeConfigSchema)
  assert.equal(result.ok, true)
  assert.ok(result.data.filesystem.denyRead.includes("~/.ssh"))
})

test("validateBaseConfig reports failure and the fallback stays safe", () => {
  const result = validateBaseConfig({ network: "not-a-config" }, SandboxRuntimeConfigSchema)
  assert.equal(result.ok, false)
  assert.deepEqual(fallbackBaseConfig().network.allowedDomains, [])
})

test("custom config resolves cwd and tmp into allowWrite", () => {
  const cfg = buildCustomConfig(resolveOptions({}), { cwd: "/repo/wt-a" })
  assert.ok(cfg.filesystem.allowWrite.includes("/repo/wt-a"))
  assert.ok(cfg.filesystem.allowWrite.some((p) => p === tmpdir()))
  assert.ok(cfg.filesystem.denyWrite.includes("/repo/wt-a/.git/config"))
})

test("custom config denies the shared git dir's config and hooks", () => {
  const cfg = buildCustomConfig(resolveOptions({}), { cwd: "/repo/wt-a", gitDir: "/repo/.git" })
  assert.ok(cfg.filesystem.allowWrite.includes("/repo/.git"))
  assert.ok(cfg.filesystem.denyWrite.includes("/repo/.git/config"))
  assert.ok(cfg.filesystem.denyWrite.includes("/repo/.git/hooks"))
})

test("custom config includes allowAllUnixSockets only when asked", () => {
  const plain = buildCustomConfig(resolveOptions({}), { cwd: "/x" })
  assert.equal(plain.network, undefined)
  const degraded = buildCustomConfig(resolveOptions({}), { cwd: "/x", allowUnixSockets: true })
  assert.equal(degraded.network.allowAllUnixSockets, true)
})

test("resolveGitCommonDir uses injected spawnSync and caches", () => {
  let calls = 0
  const deps = { spawnSync: () => { calls++; return { status: 0, stdout: "/repo/.git\n" } } }
  assert.equal(resolveGitCommonDir("/repo/wt-a", deps), "/repo/.git")
  resolveGitCommonDir("/repo/wt-a", deps)
  assert.equal(calls, 1) // cached
  assert.equal(resolveGitCommonDir("/nope", { spawnSync: () => ({ status: 1 }) }), undefined)
})

test("isSrtInvocation catches direct and chained srt calls", () => {
  assert.equal(isSrtInvocation("srt -- npm test"), true)
  assert.equal(isSrtInvocation("cd x && srt -- make"), true)
  assert.equal(isSrtInvocation("srt"), true)
  assert.equal(isSrtInvocation("npm test"), false)
  assert.equal(isSrtInvocation("echo srt -- npm test"), false)
})

test("matchesExcludedCommand: trailing star is boundary prefix (bare + args), else exact", () => {
  assert.equal(matchesExcludedCommand("docker compose up -d", ["docker compose *"]), true)
  assert.equal(matchesExcludedCommand("docker compose", ["docker compose *"]), true)
  assert.equal(matchesExcludedCommand("docker composese", ["docker compose *"]), false)
  assert.equal(matchesExcludedCommand("npmx", ["npm *"]), false)
  assert.equal(matchesExcludedCommand("docker ps", ["docker compose *"]), false)
  assert.equal(matchesExcludedCommand("docker", ["docker"]), true)
})
