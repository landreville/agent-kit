/**
 * sbx-reorder-probe — a throwaway OpenCode v2 probe plugin (Task 1 of the
 * 2026-10-10 sandbox-reorder plan).
 * It verifies the four assumptions the v2 redesign rests on by appending JSON
 * lines to `events.log` in this plugin's own directory (i.e.
 * /tmp/sbx-reorder-probe/events.log when installed via the
 * ~/.config/opencode/plugins symlink):
 *
 *   (a) ctx.session.get({ sessionID }).permissions present?
 *   (b) ctx.agent.get({ agentID }).permissions present, and does it carry the
 *       base policy? (the JS adapter returns { location, data } for agent.get,
 *       so both .permissions and .data.permissions are probed and logged)
 *   (c) for a simple command, are the permission "evaluate" resources exactly
 *       [command]? (every evaluate event is logged read-only)
 *   (d) is a tool "execute.before" input mutation honored on the FIRST tool
 *       call of a session? (drill commands get " && echo PROBE-INPUT-MUTATED"
 *       appended; honored ⇔ that string reaches the permission scanner and the
 *       spawned process)
 *
 * The mutation is scoped to the exact bare drill commands ("uptime", "date")
 * so unrelated live sessions sharing this OpenCode service are never
 * rewritten; everything else the probe does is read-only. Hook bodies never
 * throw — a throw in execute.before would fail the tool call outright.
 */
import { appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), "events.log")
const MUTATION = " && echo PROBE-INPUT-MUTATED"
const DRILL_COMMANDS = new Set(["uptime", "date"])

let ctx // the plugin context, captured at setup

const log = (record) => {
  try {
    appendFileSync(LOG_FILE, JSON.stringify(record) + "\n")
  } catch {
    /* logging must never break a hook */
  }
}

const errText = (error) => String(error?.message ?? error)

const firstRules = (rules) => (Array.isArray(rules) ? rules.slice(0, 3) : undefined)

/** (c) evidence: every permission evaluation, logged read-only. */
const onEvaluate = async (event) => {
  try {
    log({
      type: "permission.evaluate",
      action: event?.action,
      resources: event?.resources,
      effect: event?.effect,
      source: event?.source,
      sessionID: event?.sessionID,
      agent: event?.agent,
    })
  } catch (error) {
    log({ type: "hook-error", hook: "permission.evaluate", error: errText(error) })
  }
}

/** (a)/(b) evidence: the prediction inputs, fetched inside execute.before. */
const fetchRuleInputs = async (sessionID, agentID) => {
  try {
    const session = sessionID ? await ctx.session.get({ sessionID }) : undefined
    const permissions = session?.permissions
    log({
      type: "session.get",
      sessionID,
      keys: session === undefined ? undefined : Object.keys(session),
      permissionsPresent: Array.isArray(permissions),
      permissionsLength: Array.isArray(permissions) ? permissions.length : undefined,
      firstRules: firstRules(permissions),
    })
  } catch (error) {
    log({ type: "session.get-error", sessionID, error: errText(error) })
  }
  try {
    const result = agentID ? await ctx.agent.get({ agentID }) : undefined
    const permissions = result?.permissions
    const dataPermissions = result?.data?.permissions
    log({
      type: "agent.get",
      agentID,
      keys: result === undefined ? undefined : Object.keys(result),
      permissionsPresent: Array.isArray(permissions),
      dataPermissionsPresent: Array.isArray(dataPermissions),
      permissionsLength: Array.isArray(permissions) ? permissions.length : undefined,
      dataPermissionsLength: Array.isArray(dataPermissions) ? dataPermissions.length : undefined,
      firstRules: firstRules(permissions),
      dataFirstRules: firstRules(dataPermissions),
    })
  } catch (error) {
    log({ type: "agent.get-error", agentID, error: errText(error) })
  }
}

/** (d) evidence: log the call, fetch the inputs, mutate the drill command. */
const onBefore = async (event) => {
  try {
    const isShell = event?.tool === "bash" || event?.tool === "shell"
    log({
      type: "tool.execute.before",
      tool: event?.tool,
      id: event?.id,
      sessionID: event?.sessionID,
      agent: event?.agent,
      messageID: event?.messageID,
      command: isShell ? event?.input?.command : undefined,
      inputKeys: isShell ? undefined : inputKeys(event?.input),
    })
    if (!isShell) return
    await fetchRuleInputs(event.sessionID, event.agent)
    const command = event.input?.command
    if (typeof command === "string" && DRILL_COMMANDS.has(command.trim())) {
      try {
        event.input.command += MUTATION
        log({ type: "probe.mutate", id: event.id, command: event.input.command })
      } catch (error) {
        log({ type: "probe.mutate-error", id: event.id, error: errText(error) })
      }
    }
  } catch (error) {
    log({ type: "hook-error", hook: "tool.execute.before", error: errText(error) })
  }
}

/** (d) confirmation: the command as executed, its status, and its output. */
const onAfter = async (event) => {
  try {
    const isShell = event?.tool === "bash" || event?.tool === "shell"
    log({
      type: "tool.execute.after",
      tool: event?.tool,
      id: event?.id,
      sessionID: event?.sessionID,
      status: event?.status,
      command: isShell ? event?.input?.command : undefined,
      output: preview(event?.result?.output),
      error: event?.status === "error" ? errText(event?.error) : undefined,
    })
  } catch (error) {
    log({ type: "hook-error", hook: "tool.execute.after", error: errText(error) })
  }
}

function inputKeys(input) {
  if (input === null || typeof input !== "object") return typeof input
  return Object.keys(input)
}

function preview(output) {
  if (typeof output !== "string") return undefined
  return output.length > 400 ? output.slice(0, 400) + "…[truncated]" : output
}

export default {
  id: "sbx-reorder-probe",
  async setup(context) {
    ctx = context
    log({ type: "setup", directory: context?.location?.directory })
    try {
      context.permission.hook("evaluate", onEvaluate)
    } catch (error) {
      log({ type: "register-error", hook: "permission.evaluate", error: errText(error) })
    }
    try {
      context.tool.hook("execute.before", onBefore)
    } catch (error) {
      log({ type: "register-error", hook: "tool.execute.before", error: errText(error) })
    }
    try {
      context.tool.hook("execute.after", onAfter)
    } catch (error) {
      log({ type: "register-error", hook: "tool.execute.after", error: errText(error) })
    }
  },
}
