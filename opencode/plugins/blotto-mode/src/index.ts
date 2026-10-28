// src/index.ts — blotto-mode entrypoint.
export { BlottoMode } from "./plugin"

import { setup as setupV2 } from "./v2"
export default { id: "blotto-mode", setup: setupV2 }
