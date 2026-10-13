// index.js — refine-permissions OpenCode v2 plugin entry.
//
// Registers:
//   - the `refine_permissions` tool (analyze session history / apply rules)
//   - the bundled `refine-permissions` skill that drives it
// No background work: everything runs when the skill calls the tool.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { makeTool } from "./refine.js"

const here = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = join(here, "skills", "refine-permissions", "SKILL.md")

async function setup(ctx) {
  const options = ctx.options ?? {}
  try {
    await ctx.tool.transform((editor) => {
      editor.add(makeTool(ctx, options))
    })
  } catch (error) {
    console.log(`[refine-permissions] tool registration failed: ${error?.message ?? error}`)
  }

  try {
    const content = readFileSync(SKILL_PATH, "utf8")
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "refine-permissions",
        name: "refine-permissions",
        description:
          "Analyze recent session history and propose safer shell allowlist rules, then apply accepted rules to the OpenCode config.",
        path: SKILL_PATH,
        content,
        autoinvoke: true,
      })
    })
  } catch (error) {
    console.log(`[refine-permissions] skill registration failed: ${error?.message ?? error}`)
  }
}

export default { id: "refine-permissions", setup }
