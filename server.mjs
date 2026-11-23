import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Acp, AcpError } from './acp.mjs'
import { childEnvironment, loginCommand, nativeConfigDir } from './engine.mjs'
import { managedEngine, packageName } from './managed-engine.mjs'
import { nativeConfiguration } from './native-config.mjs'
import { createScopedConfig, scopedModelId, scopedProtocols } from './scoped.mjs'
import { registerRpc } from './sdk/harness/contracts.mjs'
import manifest from './plugin.json' with { type: 'json' }
import contract from './contracts/plugin.json' with { type: 'json' }

const signIn = 'Open Kiro settings in Agent management and run the native login command, then refresh the model list.'
const unavailable = 'Install Kiro CLI 3 or later from Studio Agent management.'
const ownerOnly = 'Kiro is available to the Studio account and Profile that enabled the plugin.'
const stopReasons = { end_turn: 'stop', refusal: 'stop', max_tokens: 'length', max_turn_requests: 'tool_limit' }
const toolKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const cancelled = { outcome: { outcome: 'cancelled' } }
const text = value => ({ type: 'text', text: value })
const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512
const sameOwner = (left, right) => left.userId === right.userId && left.profile === right.profile

function setupAcp(engine, cwd, onFrame, scoped) {
  const args = ['acp', '--agent-engine=v3', ...(scoped ? ['--auth-method=client'] : [])]
  return new Acp(engine, args, { cwd, env: scoped?.env ?? childEnvironment() }, onFrame)
}

async function initialize(acp, signal, allowAnonymousAgent = false) {
  const hello = await acp.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'ekko-studio-kiro', version: manifest.version },
    clientCapabilities: {},
  }, signal)
  const name = hello?.agentInfo?.name
  if (hello?.protocolVersion !== 1 || (name ? !/^kiro(?: cli)?(?: agent)?$/i.test(name) : !allowAnonymousAgent)) {
    throw new Error('The executable must provide Kiro CLI ACP V3.')
  }
  return hello.agentCapabilities ?? {}
}

function acpServers(servers, capabilities) {
  const pairs = values => Object.entries(values ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  return Object.entries(servers).map(([name, server]) => {
    if (typeof server.command === 'string' && server.command) {
      return { name, command: server.command, args: server.args ?? [], env: pairs(server.env) }
    }
    const type = server.type ?? 'http'
    if (!['sse', 'http'].includes(type) || !capabilities?.[type] || typeof server.url !== 'string') {
      throw new Error('Kiro did not advertise support for a required Studio MCP transport.')
    }
    return { name, type, url: server.url, headers: pairs(server.headers) }
  })
}

async function startSession(acp, cwd, mcpServers, capabilities, signal, additionalDirectory) {
  const session = await acp.request('session/new', {
    cwd, mcpServers: acpServers(mcpServers, capabilities.mcpCapabilities),
    ...(additionalDirectory ? { additionalDirectories: [additionalDirectory] } : {}),
  }, signal)
  if (!validId(session?.sessionId)) throw new Error('Kiro did not return a valid ACP session ID.')
  return session
}

function configOption(session, id) {
  return session.configOptions?.find(option => option.id === id)
}

function optionValues(option) {
  return option?.options?.flatMap(item => Array.isArray(item.options) ? item.options : [item]) ?? []
}

function modelsFrom(session) {
  const model = configOption(session, 'model')
  const current = model?.currentValue ?? session.models?.currentModelId
  const available = model ? optionValues(model) : session.models?.availableModels ?? []
  const efforts = optionValues(configOption(session, 'effortLevel')).map(item => item.value).filter(validId)
  const models = new Map()
  for (const item of available) {
    const id = item.value ?? item.modelId
    if (!validId(id) || models.has(id)) continue
    models.set(id, {
      id, name: validId(item.name) ? item.name : id,
      ...(id === current ? { isDefault: true } : {}),
      ...(efforts.length && id === current ? { reasoningEfforts: efforts } : {}),
    })
  }
  return models
}

async function selectConfiguration(acp, session, id, wanted, signal) {
  const option = configOption(session, id)
  const current = option?.currentValue ?? (id === 'model' ? session.models?.currentModelId : undefined)
  if (current === wanted) return session
  const available = id === 'model' ? modelsFrom(session).has(wanted) : optionValues(option).some(item => item.value === wanted)
  if (!available) throw new Error('The selected Kiro ' + id + ' is unavailable.')
  const updated = await acp.request('session/set_config_option', {
    sessionId: session.sessionId, configId: id, value: wanted,
  }, signal)
  if (configOption(updated ?? {}, id)?.currentValue !== wanted) throw new Error('Kiro did not confirm the selected ' + id + '.')
  return { ...session, configOptions: updated.configOptions }
}

function catalog(status, message, models = []) {
  return { status, source: 'kiro-acp', scope: 'available', models, ...(message ? { message } : {}) }
}

async function listModels(ctx, getEngine) {
  ctx.signal.throwIfAborted()
  const deadline = AbortSignal.timeout(20_000)
  const signal = AbortSignal.any([ctx.signal, deadline])
  let acp
  let directory
  try {
    const executable = await getEngine()
    if (!executable) return catalog('not_installed', unavailable)
    directory = await mkdtemp(join(await realpath(tmpdir()), 'kiro-catalog-'))
    signal.throwIfAborted()
    acp = setupAcp(executable, directory, ({ id }) => { if (id !== undefined) acp.methodNotFound(id) })
    ctx.lifecycle.add(() => acp.close())
    const capabilities = await initialize(acp, signal)
    const session = await startSession(acp, directory, {}, capabilities, signal)
    const models = [...modelsFrom(session).values()]
    return models.length ? catalog('ready', undefined, models) : catalog('empty', 'Kiro did not return any models.')
  } catch (error) {
    ctx.signal.throwIfAborted()
    if (deadline.aborted) return catalog('timeout', 'Kiro model discovery timed out.')
    if (error instanceof AcpError && error.code === -32000) return catalog('auth_required', signIn)
    return catalog('error', 'Could not load models from Kiro CLI. Check the executable and native configuration.')
  } finally {
    try { await acp?.close() }
    finally { if (directory) await rm(directory, { recursive: true, force: true }) }
  }
}

function scrub(value) {
  const result = (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return result
    .replace(/\bBearer\s+[^\s"'\\,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:[\w-]*(?:api[-_ ]?key|token|secret|password)|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'\\,;]+)/gi, '$1[redacted]')
    .slice(0, 4096)
}

async function requestPermission(params, run, signal) {
  const tool = params.toolCall
  const options = Array.isArray(params.options) ? params.options.filter(option => validId(option?.optionId)) : []
  const allow = options.filter(option => option.kind === 'allow_once')
  const reject = options.find(option => option.kind === 'reject_once')
  if (!validId(tool?.toolCallId) || allow.length !== 1 || new Set(options.map(option => option.optionId)).size !== options.length || signal.aborted) return cancelled
  const title = scrub(tool.title) || 'Kiro tool request'
  const raw = tool.rawInput
  const details = scrub(typeof raw === 'string' ? raw : raw?.command ?? raw?.path ?? raw?.filePath ?? params._meta?.kiro?.consent?.resource) || title
  try {
    const decision = await run.interactions.approve({ operationId: tool.toolCallId, title, details })
    if (signal.aborted) return cancelled
    const choice = decision.outcome === 'approved' ? allow[0] : decision.outcome === 'denied' ? reject : undefined
    if (choice) return { outcome: { outcome: 'selected', optionId: choice.optionId } }
  } catch {
    // Without a valid Studio answer the tool stays blocked.
  }
  return cancelled
}

function streamTurn(run) {
  let answer = ''
  const tools = new Set()
  return {
    get answer() { return answer },
    async update(update) {
      const { sessionUpdate, content, toolCallId, status, kind } = update ?? {}
      if (update?._meta?.kiro?.replay === true) return
      if (content?.type === 'text' && typeof content.text === 'string') {
        if (sessionUpdate === 'agent_message_chunk') {
          answer += content.text
          await run.output.emit({ type: 'text.delta', text: content.text })
        } else if (sessionUpdate === 'agent_thought_chunk') {
          await run.output.emit({ type: 'reasoning.summary.delta', text: content.text })
        }
      }
      if (!['tool_call', 'tool_call_update'].includes(sessionUpdate) || !validId(toolCallId)) return
      if (sessionUpdate === 'tool_call' && !tools.has(toolCallId)) {
        tools.add(toolCallId)
        await run.output.emit({ type: 'tool.started', callId: toolCallId, name: toolKinds.has(kind) ? kind : 'Kiro tool', input: {} })
      }
      if (!['completed', 'failed'].includes(status) || !tools.delete(toolCallId)) return
      await run.output.emit(status === 'completed'
        ? { type: 'tool.completed', callId: toolCallId, result: null }
        : { type: 'tool.failed', callId: toolCallId, error: 'Kiro tool failed or was denied.' })
    },
    async finish() {
      for (const callId of tools) {
        await run.output.emit({ type: 'tool.failed', callId, error: 'Kiro ended the turn without a tool result.' })
      }
    },
  }
}

function prepareAttachments(run, signal) {
  const files = new Map()
  const limit = 32 * 1024 * 1024
  let total = 0
  let directory
  let inlineBytes = 0
  return {
    get directory() { return directory },
    async block(part, capabilities) {
      signal.throwIfAborted()
      if (part.type === 'text') return part
      if (files.has(part.assetId)) {
        const previous = files.get(part.assetId)
        return previous.type === 'image' ? text('The same Studio image attachment appears earlier in this prompt.') : previous
      }
      const asset = await run.attachments.resolve(part.assetId)
      if (files.size >= 32 || asset.size > limit - total) throw new Error('Kiro accepts up to 32 attachments and 32 MiB per turn.')
      const bytes = await run.attachments.read(part.assetId)
      signal.throwIfAborted()
      total += bytes.byteLength
      if (total > limit) throw new Error('Kiro accepts up to 32 MiB of attachments per turn.')
      if (part.type === 'image' && capabilities?.image === true
        && /^image\/(?:png|jpeg|gif|webp)$/.test(asset.mediaType) && inlineBytes + bytes.byteLength <= 6 * 1024 * 1024) {
        const block = { type: 'image', mimeType: asset.mediaType, data: Buffer.from(bytes).toString('base64') }
        inlineBytes += bytes.byteLength
        files.set(part.assetId, block)
        return block
      }
      if (!directory) {
        await mkdir(run.paths.runtimeDir, { recursive: true, mode: 0o700 })
        directory = await mkdtemp(join(run.paths.runtimeDir, 'kiro-input-'))
      }
      const ext = extname(asset.name).toLowerCase()
      const path = join(directory, 'asset-' + (files.size + 1) + (/^\.[a-z\d]{1,12}$/.test(ext) ? ext : ''))
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx', signal })
      const block = text('Studio attachment ' + JSON.stringify(asset.name) + ' (' + JSON.stringify(asset.mediaType)
        + '). Available at ' + JSON.stringify(path) + '. Use your file-reading tool to inspect its contents when relevant.')
      files.set(part.assetId, block)
      return block
    },
    async dispose() {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

async function buildPrompt(input, attachments, capabilities) {
  const prompt = input.instructions.map(item => text('[' + item.kind + ']\n' + item.text))
  for (const message of input.history) {
    prompt.push(text('Previous Studio ' + message.role + ' message:'))
    for (const part of message.content) prompt.push(await attachments.block(part, capabilities))
  }
  if (input.history.length) prompt.push(text('Current Studio request:'))
  for (const part of input.input) prompt.push(await attachments.block(part, capabilities))
  return prompt
}

async function executeTurn(input, run, getEngine, signal, canUseNativeResources) {
  const executable = await getEngine()
  if (!executable) throw new Error(unavailable)
  const cwd = await realpath(run.paths.workspaceDir)
  const attachments = prepareAttachments(run, signal)
  const turn = streamTurn(run)
  const finishing = new AbortController()
  const currentSignal = AbortSignal.any([signal, finishing.signal])
  const interrupted = Promise.withResolvers()
  let acp
  let scoped
  let currentSession
  let updates = Promise.resolve()
  let streamError

  function abort() {
    interrupted.resolve()
    if (currentSession) acp.notify('session/cancel', { sessionId: currentSession })
    void acp?.close({ cancel: Boolean(currentSession) })
  }

  try {
    signal.throwIfAborted()
    if (run.mode === 'scoped') {
      scoped = await createScopedConfig(run.model, run.paths.runtimeDir, signal, canUseNativeResources ? nativeConfigDir() : undefined)
    }
    acp = setupAcp(executable, cwd, ({ id, method, params }) => {
      const current = currentSession && params?.sessionId === currentSession && !currentSignal.aborted
      if (id !== undefined) {
        if (method === '_kiro/auth/getAccessToken' && scoped && !currentSignal.aborted) acp.respond(id, scoped.proxy.auth())
        else if (method !== 'session/request_permission') acp.methodNotFound(id)
        else if (!current) acp.respond(id, cancelled)
        else {
          void requestPermission(params, run, currentSignal)
            .then(result => acp.respond(id, currentSignal.aborted ? cancelled : result))
            .catch(() => {})
        }
      } else if (current && method === 'session/update') {
        updates = updates.then(async () => {
          if (!currentSignal.aborted && !streamError) await turn.update(params.update)
        }).catch(error => { streamError = error })
      }
    }, scoped)
    signal.addEventListener('abort', abort, { once: true })
    run.lifecycle.add(() => acp.close())
    const startup = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
    const capabilities = await initialize(acp, startup, Boolean(scoped))
    const prompt = await buildPrompt(input, attachments, capabilities.promptCapabilities)
    let session = await startSession(acp, cwd, run.mcpServers ?? {}, capabilities, startup, attachments.directory)
    currentSession = session.sessionId
    if (scoped) {
      if (!scoped.proxy.listed || !modelsFrom(session).has(scopedModelId)) {
        throw new Error('This Kiro CLI did not confirm the Studio model relay.')
      }
      await selectConfiguration(acp, session, 'model', scopedModelId, startup)
    } else {
      if (run.model?.model) session = await selectConfiguration(acp, session, 'model', run.model.model, startup)
      if (run.model?.reasoningEffort) await selectConfiguration(acp, session, 'effortLevel', run.model.reasoningEffort, startup)
    }
    const result = await acp.request('session/prompt', { sessionId: currentSession, prompt }, signal)
    currentSession = undefined
    await Promise.race([updates, interrupted.promise])
    signal.throwIfAborted()
    if (streamError) throw streamError
    await Promise.race([turn.finish(), interrupted.promise])
    signal.throwIfAborted()
    if (result?.stopReason === 'cancelled') throw new Error('Kiro cancelled the prompt.')
    if (!Object.hasOwn(stopReasons, result?.stopReason)) throw new Error('Kiro returned an unsupported stop reason.')
    if (scoped && !scoped.proxy.finishReason) throw new Error('Kiro did not complete a request through the Studio model relay.')
    const finishReason = scoped?.proxy.finishReason === 'length' ? 'length' : stopReasons[result.stopReason]
    return { content: [text(turn.answer)], finishReason }
  } catch (error) {
    if (error instanceof AcpError && error.code === -32000) {
      throw new Error(scoped ? 'Kiro could not authenticate with the Studio model relay.' : signIn)
    }
    if (error instanceof AcpError) throw new Error('Kiro rejected an ACP request. Check your selected model and native configuration.')
    if (!signal.aborted && error?.name === 'TimeoutError') throw new Error('Kiro ACP startup timed out.')
    throw error
  } finally {
    finishing.abort()
    signal.removeEventListener('abort', abort)
    try { await acp?.close() }
    finally { await Promise.all([attachments.dispose(), scoped?.dispose()]) }
  }
}

function createSession(owner, session, getEngine) {
  if (session.mode !== 'scoped' && (session.mode !== 'global' || !sameOwner(owner, session.identity))) throw new Error(ownerOnly)
  const disposed = new AbortController()
  let active
  return {
    async run(input, run) {
      if (!sameOwner(session.identity, run.identity) || session.identity.sessionId !== run.identity.sessionId
        || session.identity.agentId !== run.identity.agentId || run.mode !== session.mode) throw new Error(ownerOnly)
      if (active) throw new Error('Kiro is already running in this Studio session.')
      const remaining = run.deadlineAt - Date.now()
      if (remaining <= 0) throw new Error('Kiro turn timed out.')
      const deadline = AbortSignal.timeout(remaining)
      const signal = AbortSignal.any([session.signal, run.signal, disposed.signal, deadline])
      signal.throwIfAborted()
      active = executeTurn(input, run, getEngine, signal, sameOwner(owner, run.identity))
      try { return await active }
      catch (error) {
        if (signal.aborted) throw new Error(deadline.aborted ? 'Kiro turn timed out.' : 'Kiro turn cancelled.')
        throw error
      } finally { active = undefined }
    },
    async dispose() {
      disposed.abort()
      await active?.catch(() => {})
    },
  }
}

export function apply(ctx) {
  const owner = { userId: ctx.identity.userId, profile: ctx.identity.profile }
  const manager = managedEngine(ctx.paths.dataDir)
  const getEngine = async () => (await manager.resolve()).engine
  const checkOwner = run => { if (!sameOwner(owner, run.identity)) throw new Error(ownerOnly) }
  const disposeRpc = registerRpc(ctx, contract, 'native-login', async (_input, run) => {
    checkOwner(run)
    run.signal.throwIfAborted()
    return { command: loginCommand(await getEngine()) }
  })
  const configRpc = Object.entries({
    'list-skills': 'listSkills', 'get-skill': 'getSkill', 'save-skill': 'saveSkill', 'edit-skill': 'editSkill', 'remove-skill': 'removeSkill',
    'list-mcp': 'listMcp', 'save-mcp': 'saveMcp', 'remove-mcp': 'removeMcp',
    'get-settings-editor': 'getSettingsEditor', 'save-settings-editor': 'saveSettingsEditor',
  }).map(([name, method]) => registerRpc(ctx, contract, name, async (input, run) => {
    checkOwner(run)
    run.signal.throwIfAborted()
    const result = await nativeConfiguration(nativeConfigDir())[method](input)
    if (method !== 'getSettingsEditor') return result
    run.signal.throwIfAborted()
    return { ...result, loginCommand: loginCommand(await getEngine()), status: await manager.status(run.signal) }
  }))
  const registration = ctx.extensions.agents.register({
    id: 'kiro', name: 'Kiro CLI', vendor: 'Kiro', description: manifest.description,
    agentApiVersion: 1,
    getStatus: run => manager.status(run.signal),
    management: {
      installGuideUrl: manifest.documentation,
      settings(run) { checkOwner(run); return { viewId: 'skills' } },
      ...(packageName() ? {
        checkUpdate(run) { checkOwner(run); return manager.checkUpdate(run) },
        upgrade(input, run) { checkOwner(run); return manager.upgrade(input, run) },
        remove(run) { checkOwner(run); return manager.remove(run) },
      } : {}),
    },
    modes: {
      global: { listModels: run => sameOwner(owner, run.identity) ? listModels(run, getEngine) : catalog('auth_required', ownerOnly) },
      scoped: { protocols: scopedProtocols },
    },
    features: { surfaces: ['chat'], streaming: true, resume: false },
    runtime: { createSession: session => createSession(owner, session, getEngine) },
  })
  return async () => { await Promise.all([registration.dispose(), disposeRpc(), ...configRpc.map(dispose => dispose())]) }
}
