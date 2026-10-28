// Root entrypoint shim. OpenCode's plugin loader resolves a plugin directory
// by its root index file (index.js / index.ts) and does not consult the
// package.json "main" field, so without this file the loader silently skips
// the whole directory — not even a "loading plugin" log line appears.
// Keep the real entrypoint and registration in src/index.ts; this shim only
// re-exports the default binding so the plugin registers exactly once.
import plugin from "./src/index"

export default plugin
