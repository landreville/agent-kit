import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import plugin from "../index.js"

test("setup registers the refine_permissions tool and the skill", async () => {
  const tools = []
  const skills = []
  const ctx = {
    options: {},
    tool: { transform: async (cb) => cb({ add: (t) => tools.push(t) }) },
    skill: { transform: async (cb) => cb({ add: (s) => skills.push(s) }) },
  }
  await plugin.setup(ctx)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "refine_permissions")
  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.id, "refine-permissions")
  assert.equal(skill.autoinvoke, true)
  const onDisk = readFileSync(new URL("../skills/refine-permissions/SKILL.md", import.meta.url), "utf8")
  assert.equal(skill.content, onDisk)
  assert.ok(skill.path.endsWith("skills/refine-permissions/SKILL.md"))
})

test("SKILL.md names the three question options and both tool modes", () => {
  const text = readFileSync(new URL("../skills/refine-permissions/SKILL.md", import.meta.url), "utf8")
  assert.match(text, /name: refine-permissions/)
  for (const option of ["Accept all", "Fine-tune", "Reject"]) assert.ok(text.includes(option))
  assert.ok(text.includes('mode: "analyze"'))
  assert.ok(text.includes('mode: "apply"'))
})
