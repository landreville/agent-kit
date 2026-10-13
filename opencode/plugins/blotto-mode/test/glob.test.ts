import { test, expect } from "bun:test"
import { globMatch } from "../src/glob"

test("glob semantics match opencode.json", () => {
  expect(globMatch("git status *", "git status --short")).toBe(true)
  expect(globMatch("git status *", "git status")).toBe(false)
  expect(globMatch("npm test*", "npm test")).toBe(true)
  expect(globMatch("rm ?", "rm x")).toBe(true)
  expect(globMatch("rm ?", "rm xy")).toBe(false)
  expect(globMatch("*.internal.example.com", "a.internal.example.com")).toBe(true)
  expect(globMatch("a.b", "aXb")).toBe(false)
})
