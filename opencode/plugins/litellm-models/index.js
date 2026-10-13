// index.js — litellm-models entrypoint for OpenCode v1 and v2.
// V1 loads the object's server(); V2 loads id/setup. Each generation
// runs only its own entry — no runtime version detection.
import { setup as setupV2 } from "./v2.js"
import { server as serverV1 } from "./v1.js"

export default {
  id: "litellm-models",
  setup: setupV2,
  server: serverV1,
}
