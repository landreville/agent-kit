import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// OpenCode resolves a plugin directory to its ROOT index file (index.js /
// index.ts); the package.json "main" field is not consulted. Without a root
// entry the loader silently skips the plugin — this is exactly how blotto-mode
// failed to load in practice (not even a "loading plugin" log line).
describe("loader entrypoint", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

  test("has a root index entry file", () => {
    expect(
      fs.existsSync(path.join(root, "index.ts")) ||
        fs.existsSync(path.join(root, "index.js")),
    ).toBe(true)
  })

  test("root entry default-exports the plugin", async () => {
    const mod = await import(path.join(root, "index.ts"))
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe("blotto-mode")
    expect(typeof mod.default.setup).toBe("function")
  })
})
