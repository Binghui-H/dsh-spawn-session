/**
 * Cordis plugin: orchestrate Sessions from inside a Session.
 *
 * Two tools:
 *
 * - `spawn_session` creates a NEW Session inside a chosen Workspace and prompts
 *   it. Creating it inside the Host process is what makes the row appear at
 *   once: `session/created` emits `api-session/added`, every connected window
 *   upserts the row, and `workspace.attachSession` publishes the group
 *   membership increment. Nothing is refreshed, restarted, or clicked.
 *
 * - `ask_session` messages a Session that is already live in this Host, and can
 *   either wait for its answer or hand the answer back to the calling Session as
 *   a fresh turn. The wake is the Host's own inbox mechanism: `agent.followup()`
 *   splices into `next-turn` with `wakeup: true`, so an idle Agent starts a new
 *   turn when that message lands.
 *
 * The module deliberately imports nothing from `@deepseek-ai/*`. A linked
 * Profile plugin resolves bare specifiers through the Profile's shared
 * directory, which may hold a different release line than the running Host; the
 * three values it would have imported (`createUserMessage`, `defineTool`,
 * `SessionSeq`) are trivial and are built here instead, so the plugin cannot
 * bind to the wrong version.
 *
 * @module dsh-spawn-session
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** Cordis plugin name. */
export const name = 'spawn-session'

/** Every capability the orchestration transaction touches. */
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
  /** How many hand-offs a chain of `ask_session` calls may span. */
  maxHops: 3,
  /** How long `ask_session(wait: true)` blocks before reporting a timeout. */
  answerTimeoutMs: 120_000,
  /** How long a pending hand-off listens for the target turn before giving up. */
  watchTtlMs: 1_800_000,
}

/** Prefix every injected wake message carries, so a human can tell it apart. */
const NOTICE_PREFIX = '[dsh-spawn-session]'

/** Read one optional string setting, falling back to its default. */
function readString(config, key) {
  const value = config?.[key]
  if (value === undefined) return DEFAULTS[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`spawn-session: ${key} must be a non-empty string or null`)
  }
  return value
}

/** Read one optional positive integer setting, falling back to its default. */
function readInteger(config, key) {
  const value = config?.[key]
  if (value === undefined) return DEFAULTS[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`spawn-session: ${key} must be a positive integer`)
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
 * @param {string} text - message text.
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

/** Collect the text blocks of one assistant message. */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
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

/** Describe one finished target for the waking message. */
function buildNotice({ sessionId, title, reply, note, failure }) {
  const heading = failure === undefined
    ? (title === undefined
        ? `${NOTICE_PREFIX} 会话 ${sessionId} 已完成。`
        : `${NOTICE_PREFIX} 会话 ${sessionId}（${title}）已完成。`)
    : (title === undefined
        ? `${NOTICE_PREFIX} 会话 ${sessionId} 这一轮失败了。`
        : `${NOTICE_PREFIX} 会话 ${sessionId}（${title}）这一轮失败了。`)
  const parts = [heading]
  if (note !== undefined) parts.push(`你的备注：${note}`)
  if (failure !== undefined) parts.push(`失败原因：${failure}`)
  parts.push(reply === '' ? '它的最后回复：(没有文本输出)' : `它的最后回复：\n${reply}`)
  return parts.join('\n')
}

/**
 * Model selection a spawned Session should start with: the caller's own, read
 * from its last request header. A child that inherits a working model can think;
 * one that falls back to an exhausted Profile default cannot.
 * @param ctx - calling context.
 * @param callerAgent - the Agent whose tool call is in flight, if any.
 * @returns provider and model to create the child with.
 */
function inheritSelection(ctx, callerAgent) {
  const config = callerAgent?.session?.requestHeader?.()?.config
  if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  const fallback = ctx.agentDefaultModel.currentSelection()
  return { provider: fallback.provider, model: fallback.model }
}

/**
 * Register the orchestration tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - calling context.
 * @param {Record<string, unknown>} [config] - optional plugin settings.
 */
export function apply(ctx, config) {
  const settings = {
    agentPreset: readString(config, 'agentPreset'),
    permissionPreset: readString(config, 'permissionPreset'),
    fallbackPermissionPreset: readString(config, 'fallbackPermissionPreset'),
    maxHops: readInteger(config, 'maxHops'),
    answerTimeoutMs: readInteger(config, 'answerTimeoutMs'),
    watchTtlMs: readInteger(config, 'watchTtlMs'),
  }

  /** Hand-off depth of the chain each Session currently belongs to. */
  const hops = new Map()
  /** Messages this plugin injected, which must not reset a chain's depth. */
  const injected = new Set()

  // A genuine human message starts a new chain: only messages this plugin did
  // not inject reset the depth, so a wake notice cannot restart the budget.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const message = event.data?.message ?? event.data
    if (message === undefined || message.source?.kind !== 'user') return
    if (typeof message.id === 'string' && injected.has(message.id)) return
    hops.set(session.id, 0)
  })

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
        provider: {
          type: 'string',
          description: 'Optional provider route for the new Session; requires model. Defaults to the calling Session\'s provider.',
        },
        model: {
          type: 'string',
          description: 'Optional model id for the new Session; requires provider. Defaults to the calling Session\'s model.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'workspacePath', 'permissionPreset', 'provider', 'model'],
        properties: {
          sessionId: { type: 'string' },
          workspacePath: { type: 'string' },
          permissionPreset: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Spawned ${value.sessionId} in ${value.workspacePath} `
          + `(permission: ${value.permissionPreset}, model: ${value.provider}/${value.model}).`,
      }],
    },
    async execute(args, exec) {
      if (typeof args.workspacePath !== 'string' || !isAbsolute(args.workspacePath)) {
        throw new TypeError(`spawn_session workspacePath must be an absolute path, got ${JSON.stringify(args.workspacePath)}`)
      }
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new TypeError('spawn_session prompt must be a non-empty string')
      }
      const hasProvider = typeof args.provider === 'string' && args.provider.trim() !== ''
      const hasModel = typeof args.model === 'string' && args.model.trim() !== ''
      if (hasProvider !== hasModel) {
        throw new TypeError('spawn_session provider and model must be given together')
      }

      // Resolve everything before creating, so a misconfigured Profile fails here
      // instead of leaving a half-built Session behind.
      const permission = resolvePermission(ctx, settings)
      const preset = await ctx.agentPresets.resolve(settings.agentPreset)
      const scope = await ctx.agentPresets.acquireScope(preset.id)

      try {
        const workspace = await ctx.workspaceRegistry.create(args.workspacePath)
        // Inherit the CALLING Session's model by default. The Profile default can
        // be exhausted or unable to serve, and a child that cannot think is worse
        // than no child at all; the caller is by definition able to run right now.
        const selection = hasProvider
          ? { provider: args.provider, model: args.model }
          : inheritSelection(ctx, exec?.agent)
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
          provider: selection.provider,
          model: selection.model,
        }
      } finally {
        await releaseScope(scope)
      }
    },
  })

  ctx.tools.register({
    name: 'ask_session',
    description:
      'Send a message to a Session that is already live in this Host, for example one created by spawn_session '
      + 'or one the user is watching in the sidebar. With wait:false (default) the call returns immediately and, '
      + 'when that Session finishes its turn, this plugin delivers its answer back into the CALLING Session as a '
      + 'new turn — that wake is how the caller resumes without polling. With wait:true the call blocks until the '
      + 'target finishes (bounded by answerTimeoutMs) and returns the answer directly. '
      + 'Only live sessions are addressable; a session that is not resident in this Host is rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'prompt'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Identity of the live target Session, as returned by spawn_session.',
        },
        prompt: {
          type: 'string',
          description: 'The message sent to the target Session.',
        },
        wait: {
          type: 'boolean',
          description: 'Block until the target finishes and return its answer, instead of returning at once and waking later.',
        },
        note: {
          type: 'string',
          description: 'Optional note echoed back in the waking message, e.g. what this hand-off is for.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'status'],
        properties: {
          sessionId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['answered', 'queued', 'timeout', 'error'],
          },
          reply: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'answered'
          ? `Session ${value.sessionId} answered:\n${value.reply ?? ''}`
          : value.status === 'error'
            ? `Session ${value.sessionId} FAILED this turn: ${value.error ?? 'unknown error'}`
            : value.status === 'queued'
              ? `Queued for ${value.sessionId}; the caller is woken when that turn ends.`
              : `Session ${value.sessionId} is still running after the wait budget; the caller is woken when that turn ends.`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('ask_session requires an owning agent session')

      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
        throw new TypeError('ask_session sessionId must be a non-empty string')
      }
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new TypeError('ask_session prompt must be a non-empty string')
      }

      const target = ctx.agents.get(args.sessionId)
      if (target === undefined) {
        throw new Error(
          `session "${args.sessionId}" is not live in this Host, so it cannot be messaged; `
          + 'only sessions resident here (spawned, or open in the UI) are addressable',
        )
      }

      const callerSession = caller.session
      const callerId = callerSession.id
      if (target.session.id === callerId) throw new Error('ask_session cannot target the calling session')

      const depth = (hops.get(callerId) ?? 0) + 1
      if (depth > settings.maxHops) {
        throw new Error(`ask_session exceeded maxHops (${settings.maxHops}); a hand-off chain may not grow further`)
      }

      // Only a `turn/end` past this mark belongs to the turn this call starts.
      const baseline = target.session.seq
      let latest = ''
      /** Message of the failure that ended the target turn, when it failed. */
      let failure
      let settled = false
      /** Whether the tool call already returned a result to the caller. */
      let reported = false
      let resolveAnswer
      const answered = new Promise(resolve => { resolveAnswer = resolve })

      const cleanup = () => {
        if (settled) return
        settled = true
        off()
        clearTimeout(ttlTimer)
        clearTimeout(answerTimer)
      }

      const settle = (reason) => {
        cleanup()
        hops.set(callerId, depth)
        if (reason === 'answered' && !reported) {
          reported = true
          resolveAnswer({ sessionId: target.session.id, status: 'answered', reply: latest })
          return
        }
        // A failed turn is reported as a failure, never as an empty answer: the
        // caller must not mistake "it crashed" for "it said nothing".
        if (reason === 'error' && !reported) {
          reported = true
          resolveAnswer({ sessionId: target.session.id, status: 'error', error: failure ?? 'unknown error' })
          return
        }
        // Either the call already returned (queued, or the wait budget elapsed),
        // or the watch itself expired: deliver what we have as a new turn so the
        // caller is still woken instead of losing the answer.
        const notice = userMessage(buildNotice({
          sessionId: target.session.id,
          title: undefined,
          reply: latest,
          failure: reason === 'error' ? (failure ?? 'unknown error') : undefined,
          note: typeof args.note === 'string' && args.note.trim() !== '' ? args.note : undefined,
        }))
        injected.add(notice.id)
        caller.followup(notice)
        reported = true
        resolveAnswer({
          sessionId: target.session.id,
          status: reason === 'error' ? 'error' : reason === 'answered' ? 'answered' : 'timeout',
          ...(reason === 'error' ? { error: failure ?? 'unknown error' } : {}),
        })
      }

      const off = ctx.on('session/event', (session, event) => {
        if (session.id !== target.session.id) return
        if (event.seq <= baseline) return
        if (event.type === 'assistant/message') {
          const text = textOf(event.data?.message)
          if (text !== '') latest = text
          return
        }
        if (event.type === 'turn/end') {
          const reason = event.data?.reason
          if (reason?.kind === 'error') {
            const error = reason.error
            failure = typeof error?.message === 'string'
              ? (typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message)
              : 'unknown error'
            settle('error')
            return
          }
          settle('answered')
        }
      })

      const ttlTimer = setTimeout(() => {
        if (settled) return
        settle('timeout')
        ctx.logger?.warn?.(`spawn-session: hand-off to "${target.session.id}" expired before that turn ended`)
      }, settings.watchTtlMs)
      ttlTimer.unref?.()

      const answerTimer = setTimeout(() => {
        if (settled || reported) return
        // The wait budget is a reporting limit, not a cancellation: keep
        // listening so the caller is still woken when the turn really ends.
        reported = true
        resolveAnswer({ sessionId: target.session.id, status: 'timeout' })
      }, settings.answerTimeoutMs)
      answerTimer.unref?.()

      target.followup(userMessage(args.prompt))

      if (args.wait !== true) {
        reported = true
        resolveAnswer({ sessionId: target.session.id, status: 'queued' })
      }
      return answered
    },
  })
}
