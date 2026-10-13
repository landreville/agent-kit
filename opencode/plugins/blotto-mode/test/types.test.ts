import { test, expect } from "bun:test"
import type { Decision } from "../src/types"
import parse from "bash-parser"

test("types compile and bash-parser loads", () => {
  const d: Decision = { status: "ask", reason: "x", settledBy: "fallback" }
  expect(d.status).toBe("ask")
  const ast = parse("echo hi && ls", { mode: "bash" })
  expect(ast.type).toBe("Script")
})
