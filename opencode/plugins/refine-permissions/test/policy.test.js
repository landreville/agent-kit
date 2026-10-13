import { test } from "node:test"
import assert from "node:assert/strict"
import { extractFamilies } from "../policy.js"

test("extractFamilies splits compound commands and dedupes", () => {
  assert.deepEqual(extractFamilies("git fetch origin && git fetch upstream"), ["git fetch"])
  assert.deepEqual(extractFamilies("ls -la | grep foo | wc -l"), ["ls", "grep", "wc"])
  assert.deepEqual(extractFamilies("cd /tmp && echo hi; sort x"), ["cd", "echo", "sort"])
  // only the first line is a command — later lines are heredoc bodies / script text
  assert.deepEqual(extractFamilies("cat a\nhead b"), ["cat"])
})

test("extractFamilies skips leading env assignments", () => {
  assert.deepEqual(extractFamilies("RAILS_ENV=test bin/rails test"), ["bin/rails"])
  assert.deepEqual(extractFamilies("FOO=1 BAR=2 grep x"), ["grep"])
})

test("extractFamilies never fabricates families from redirections or substitutions", () => {
  assert.deepEqual(extractFamilies("ls -la /x 2>&1 | head -5"), ["ls", "head"])
  assert.deepEqual(extractFamilies("KEY=$(python3 -c \"print(1)\")"), ["KEY=$(python3"])
  assert.ok(!extractFamilies('p=$(python3 -c "import json; print(1)")').includes("-c"))
})

test("extractFamilies tolerates unbalanced quotes without throwing", () => {
  assert.deepEqual(extractFamilies('echo "unclosed; grep x'), ["echo"])
  assert.deepEqual(extractFamilies(""), [])
  assert.deepEqual(extractFamilies("   "), [])
})

test("extractFamilies uses two-token families for multi-subcommand tools", () => {
  assert.deepEqual(extractFamilies("git fetch origin"), ["git fetch"])
  assert.deepEqual(extractFamilies("docker compose ps"), ["docker compose"])
  assert.deepEqual(extractFamilies("gh pr list"), ["gh pr"])
})
