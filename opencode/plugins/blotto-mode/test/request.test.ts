import { test, expect } from "bun:test"
import { normalize, kindOf } from "../src/request"
import type { Permission } from "@opencode-ai/sdk"

const env = { worktree: "/home/u/proj", directory: "/home/u/proj", homedir: "/home/u" }
const base: Permission = { id: "p1", type: "bash", sessionID: "s1", messageID: "m1", callID: "c1", title: "t", metadata: {}, time: { created: 0 } }

test("kindOf maps known types and MCP tools", () => {
  expect(kindOf("bash")).toBe("bash")
  // OpenCode v2 renamed the shell tool's permission action to "shell".
  expect(kindOf("shell")).toBe("bash")
  expect(kindOf("external_directory")).toBe("external_directory")
  expect(kindOf("playwright__browser_navigate")).toBe("mcp")
  expect(kindOf("doom_loop")).toBeUndefined()
})

test("bash string pattern is parsed", () => {
  const r = normalize({ ...base, pattern: "git status && rm -rf /" }, env)!
  expect(r.kind).toBe("bash")
  expect(r.commands!.map((c) => c.name)).toEqual(["git", "rm"])
})

test("bash string[] pattern joins with newline and parses every element", () => {
  const r = normalize({ ...base, pattern: ["git status", "rm -rf /"] }, env)!
  expect(r.pattern).toBe("git status\nrm -rf /")
  expect(r.commands!.map((c) => c.name)).toEqual(["git", "rm"])
})

test("metadata.command wins over pattern for bash", () => {
  const r = normalize({ ...base, pattern: "git *", metadata: { command: "git push" } }, env)!
  expect(r.pattern).toBe("git push")
})

test("webfetch yields a URL; invalid URL stays undefined", () => {
  expect(normalize({ ...base, type: "webfetch", pattern: "https://example.com/a?b=1" }, env)!.url!.hostname).toBe("example.com")
  expect(normalize({ ...base, type: "webfetch", pattern: "not a url" }, env)!.url).toBeUndefined()
})

test("edit and external_directory resolve paths against directory and ~", () => {
  expect(normalize({ ...base, type: "edit", pattern: "src/a.ts" }, env)!.path).toBe("/home/u/proj/src/a.ts")
  expect(normalize({ ...base, type: "external_directory", pattern: "~/.ssh" }, env)!.path).toBe("/home/u/.ssh")
})

test("mcp splits server and tool", () => {
  const r = normalize({ ...base, type: "playwright__browser_navigate", pattern: "https://x.y" }, env)!
  expect(r.mcp).toEqual({ server: "playwright", tool: "browser_navigate" })
})

test("unhandled type returns undefined", () => {
  expect(normalize({ ...base, type: "doom_loop" }, env)).toBeUndefined()
})
