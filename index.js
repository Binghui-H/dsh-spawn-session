/**
 * Cordis plugin: spawn a Session into a chosen Workspace and prompt it.
 *
 * Creating the Session inside the Host process is what makes it appear at once:
 * `session/created` emits `api-session/added`, every connected window upserts the
 * row, and `workspace.attachSession` publishes the group membership increment.
 * Nothing has to be refreshed, restarted, or clicked.
 *
 * The module deliberately imports nothing from `@deepseek-ai/*`. A linked
 * Profile plugin resolves bare specifiers through the Profile's shared
 * directory, which may hold a different release line than the running Host; both
 * values it would have imported (`createUserMessage`, `defineTool`) are trivial
 * and are built here instead, so the plugin cannot bind to the wrong version.
 *
 * @module dsh-spawn-session
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** Cordis plugin name. */
export const name = 'spawn-session'

/** Every capability the spawn transaction touches. */
export const inject = [
  'tools',
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'sessionTitle',
  'workspaceRegistry',
]

/** Default plugin settings, each overridable from the Profile patch. */
const DEFAULTS = {
  /** Agent preset every spawned Session runs under. */
  agentPreset: 'standard',
  /** Permission preset every spawned Session runs under. */
  permissionPreset: 'spawn-write',
  /**
   * Preset used when {@link DEFAULTS.permissionPreset} is not defined in this
   * Profile. Set it to `null` to fail instead of degrading.
   */
  fallbackPermissionPreset: 'workspace-write',
}

/** Read one optional setting, falling back to its default. */
function readSetting(config, key) {
  const value = config?.[key]
  if (value === undefined) return DEFAULTS[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`spawn-session: ${key} must be a non-empty string or null`)
  }
  return value
}

/** Freeze a JSON value recursively, matching how the Host publishes messages. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/**
 * Build the user message the Host's `createUserMessage` would build:
 * `deepFreeze(structuredClone({ ...input, role: 'user', id }))`.
 * @param {string} text - prompt text.
 * @returns frozen user message.
 */
function userMessage(text) {
  return deepFreeze(structuredClone({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  }))
}

/** Release one preset scope across engines that expose either disposal symbol. */
async function releaseScope(scope) {
  if (scope === null || scope === undefined) return
  const asyncDispose = scope[Symbol.asyncDispose]
  if (typeof asyncDispose === 'function') return asyncDispose.call(scope)
  const dispose = scope[Symbol.dispose]
  if (typeof dispose === 'function') return dispose.call(scope)
}

/**
 * Resolve the permission preset, degrading to the configured fallback when the
 * Profile does not define the preferred one. A Profile that never added the
 * preset row is the common case for a freshly installed plugin, so failing hard
 * would make every spawn impossible there.
 * @param ctx - calling context.
 * @param settings - resolved plugin settings.
 * @returns the resolved preset spec, which carries `name`.
 */
function resolvePermission(ctx, settings) {
  try {
    return ctx.permissionPresets.resolve(settings.permissionPreset)
  } catch (error) {
    const fallback = settings.fallbackPermissionPreset
    if (fallback === null || fallback === settings.permissionPreset) throw error
    let resolved
    try {
      resolved = ctx.permissionPresets.resolve(fallback)
    } catch {
      throw error
    }
    ctx.logger?.warn?.(
      `spawn-session: permission preset "${settings.permissionPreset}" is not defined in this Profile; `
      + `falling back to "${resolved.name}", whose approval policy may interrupt the spawned Session. `
      + 'Add the preset to the Profile patch to silence this.',
    )
    return resolved
  }
}

/**
 * Register the `spawn_session` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - calling context.
 * @param {Record<string, unknown>} [config] - optional plugin settings.
 */
export function apply(ctx, config) {
  const settings = {
    agentPreset: readSetting(config, 'agentPreset'),
    permissionPreset: readSetting(config, 'permissionPreset'),
    fallbackPermissionPreset: readSetting(config, 'fallbackPermissionPreset'),
  }

  ctx.tools.register({
    name: 'spawn_session',
    description:
      'Create a NEW Session inside the Workspace at workspacePath (creating that Workspace when it does not '
      + 'exist yet), attach it to that group, and send it the prompt so it starts working immediately. '
      + 'The new row appears in the target group at once, with no refresh and no restart. '
      + 'Use it when the user wants work started in a different workspace than this one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['workspacePath', 'prompt'],
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the target Workspace; the new Session works in this directory.',
        },
        prompt: {
          type: 'string',
          description: 'The first user message sent to the new Session.',
        },
        title: {
          type: 'string',
          description: 'Optional Session title; defaults to the head of the prompt.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'workspacePath', 'permissionPreset'],
        properties: {
          sessionId: { type: 'string' },
          workspacePath: { type: 'string' },
          permissionPreset: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Spawned ${value.sessionId} in ${value.workspacePath} (permission: ${value.permissionPreset}).`,
      }],
    },
    async execute(args) {
      if (typeof args.workspacePath !== 'string' || !isAbsolute(args.workspacePath)) {
        throw new TypeError(`spawn_session workspacePath must be an absolute path, got ${JSON.stringify(args.workspacePath)}`)
      }
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new TypeError('spawn_session prompt must be a non-empty string')
      }

      // Resolve everything before creating, so a misconfigured Profile fails here
      // instead of leaving a half-built Session behind.
      const permission = resolvePermission(ctx, settings)
      const preset = await ctx.agentPresets.resolve(settings.agentPreset)
      const scope = await ctx.agentPresets.acquireScope(preset.id)

      try {
        const workspace = await ctx.workspaceRegistry.create(args.workspacePath)
        const selection = ctx.agentDefaultModel.currentSelection()
        const sessionId = `session-${randomUUID()}`

        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: workspace.path, agentPreset: preset.id },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.id)
          },
        })

        await workspace.attachSession(sessionId)
        ctx.permissionPresets.set(handle.agent.session, permission.name)
        ctx.sessionTitle.rename(
          handle.agent.session,
          typeof args.title === 'string' && args.title.trim() !== ''
            ? args.title
            : args.prompt.trim().slice(0, 40),
        )

        handle.agent.followup(userMessage(args.prompt))

        return {
          sessionId,
          workspacePath: workspace.path,
          permissionPreset: permission.name,
        }
      } finally {
        await releaseScope(scope)
      }
    },
  })
}
