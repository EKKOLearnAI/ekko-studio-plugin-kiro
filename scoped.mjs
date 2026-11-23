import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { childEnvironment } from './engine.mjs'

export const scopedProtocols = ['chat_completions']
export const scopedModelId = 'studio-scoped-model'

const profileArn = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/STUDIOSCOPED'
const kasJson = 'application/x-amz-json-1.0'
const maxRequestSize = 32 * 1024 * 1024
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asText = value => typeof value === 'string' ? value : ''
const kasStopReasons = { stop: 'END_TURN', tool_calls: 'TOOL_USE', length: 'MAX_TOKENS', content_filter: 'CONTENT_FILTERED' }
const imageTypes = { png: 'png', jpeg: 'jpeg', jpg: 'jpeg', gif: 'gif', webp: 'webp' }

function imagePart(image) {
  const format = typeof image?.format === 'string' && Object.hasOwn(imageTypes, image.format)
    ? imageTypes[image.format] : undefined
  const bytes = image?.source?.bytes
  if (!format || typeof bytes !== 'string' || !bytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(bytes)) {
    throw new Error('Kiro sent an unsupported image format.')
  }
  return { type: 'image_url', image_url: { url: 'data:image/' + format + ';base64,' + bytes } }
}

function userMessage(messages, user) {
  const results = user.userInputMessageContext?.toolResults ?? []
  for (const result of results) {
    if (typeof result.toolUseId !== 'string' || !Array.isArray(result.content)) throw new Error('Invalid Kiro tool result.')
    const content = result.content.map(part => {
      if (typeof part.text === 'string') return part.text
      return Object.hasOwn(part, 'json') ? JSON.stringify(part.json) : JSON.stringify(part)
    }).join('\n')
    messages.push({ role: 'tool', tool_call_id: result.toolUseId, content })
  }
  const text = asText(user.content)
  const images = user.images ?? []
  if (images.length) {
    messages.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images.map(imagePart)] })
  } else if (text || !results.length) {
    messages.push({ role: 'user', content: text })
  }
}

export function scopedRequest(state, model) {
  const current = state?.currentMessage?.userInputMessage
  if (!current || current.modelId !== scopedModelId) throw new Error('Kiro did not use the Studio model binding.')
  const messages = []
  for (const item of state.history ?? []) {
    if (item.userInputMessage) userMessage(messages, item.userInputMessage)
    else if (item.assistantResponseMessage) {
      const assistant = item.assistantResponseMessage
      const toolCalls = (assistant.toolUses ?? []).map(tool => ({
        id: tool.toolUseId, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
      }))
      messages.push({
        role: 'assistant', content: asText(assistant.content) || (toolCalls.length ? null : ''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
    }
  }
  userMessage(messages, current)
  const tools = (current.userInputMessageContext?.tools ?? []).map(entry => {
    const tool = entry.toolSpecification
    if (!tool?.name || !isObject(tool.inputSchema?.json)) throw new Error('Kiro sent an invalid tool definition.')
    return { type: 'function', function: { name: tool.name, description: asText(tool.description), parameters: tool.inputSchema.json } }
  })
  return {
    model: model.model, messages, stream: true,
    ...(tools.length ? { tools } : {}),
    ...(Number.isSafeInteger(model.outputLimit) && model.outputLimit > 0 ? { max_tokens: model.outputLimit } : {}),
    ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
  }
}

// KAS consumes Smithy EventStream frames over an AWS JSON 1.0 response.
export function kasEvent(type, data, kind = 'event') {
  const headers = Buffer.concat(Object.entries({
    ':message-type': kind, [kind === 'exception' ? ':exception-type' : ':event-type']: type,
    ':content-type': 'application/json',
  }).map(([key, value]) => {
    const name = Buffer.from(key)
    const bytes = Buffer.from(value)
    const header = Buffer.alloc(name.length + 4)
    header[0] = name.length
    name.copy(header, 1)
    header[name.length + 1] = 7
    header.writeUInt16BE(bytes.length, name.length + 2)
    return Buffer.concat([header, bytes])
  }))
  const payload = Buffer.from(JSON.stringify(data))
  const size = headers.length + payload.length + 16
  const frame = Buffer.alloc(size)
  frame.writeUInt32BE(size)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8)
  headers.copy(frame, 12)
  payload.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(crc32(frame.subarray(0, size - 4)), size - 4)
  return frame
}

async function* chatChunks(body) {
  let buffer = ''
  let lines = []
  let eventLength = 0
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) {
        eventLength += line.length
        if (eventLength > maxRequestSize) throw new Error('Studio model event is too large.')
        lines.push(line.slice(5).trimStart())
      }
      if (line || !lines.length) continue
      const data = lines.join('\n')
      lines = []
      eventLength = 0
      if (data === '[DONE]') return
      yield JSON.parse(data)
    }
    if (buffer.length > maxRequestSize) throw new Error('Studio model stream is too large.')
  }
  if (lines.length || buffer) throw new Error('Studio model stream ended mid-event.')
}

async function writeEvent(response, type, value, signal) {
  if (!response.write(kasEvent(type, value))) await once(response, 'drain', { signal })
}

async function forwardInference(data, response, upstream, model, signal) {
  const request = scopedRequest(data.conversationState, model)
  const reply = await fetch(upstream, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: 'Bearer ' + model.token, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!reply.ok || !reply.body || !reply.headers.get('content-type')?.includes('text/event-stream')) {
    await reply.body?.cancel()
    throw new Error('Studio did not return a model stream.')
  }

  response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'cache-control': 'no-store' })
  await writeEvent(response, 'initial-response', {}, signal)
  const tools = new Map()
  let finishReason
  for await (const chunk of chatChunks(reply.body)) {
    if (chunk.error) throw new Error('Studio model stream failed.')
    const choice = chunk.choices?.find(item => item.index === 0)
    if (!choice) continue
    const delta = choice.delta
    finishReason = choice.finish_reason || finishReason
    const content = asText(delta?.content)
    if (content) await writeEvent(response, 'assistantResponseEvent', { content }, signal)
    for (const call of delta?.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 128) throw new Error('Invalid model tool index.')
      const tool = tools.get(call.index) ?? { input: '' }
      if (call.id) tool.toolUseId = call.id
      if (call.function?.name) tool.name = call.function.name
      tool.input += asText(call.function?.arguments)
      if (tool.input.length > 1024 * 1024) throw new Error('Studio tool arguments are too large.')
      tools.set(call.index, tool)
    }
  }
  if (!Object.hasOwn(kasStopReasons, finishReason)) throw new Error('Studio model stream did not finish.')
  for (const tool of tools.values()) {
    if (!tool.toolUseId || !tool.name || !isObject(JSON.parse(tool.input || '{}'))) throw new Error('Invalid model tool call.')
    await writeEvent(response, 'toolUseEvent', { ...tool, input: tool.input || '{}' }, signal)
    await writeEvent(response, 'toolUseEvent', { toolUseId: tool.toolUseId, stop: true }, signal)
  }
  await writeEvent(response, 'metadataEvent', { stopReason: kasStopReasons[finishReason] }, signal)
  response.end()
  return finishReason
}

async function requestJson(request) {
  const parts = []
  let length = 0
  for await (const part of request) {
    length += part.length
    if (length > maxRequestSize) throw new Error('Kiro request is too large.')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

const preferenceOperations = new Set([
  'KiroControlPlaneBearerService.GetUserPreference',
  'KiroControlPlaneBearerService.GetUsageLimits',
  'KiroRuntimeService.GetFeatureConfiguration',
])

async function startProxy(model, signal) {
  const upstream = new URL(model.baseUrl)
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash
    || !model.token || !model.model || !scopedProtocols.includes(model.apiMode)) throw new Error('Invalid Studio scoped model binding.')
  upstream.pathname = upstream.pathname.replace(/\/+$/, '') + '/chat/completions'
  const key = randomBytes(24).toString('base64url')
  let listed = false
  let finishReason
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + key) { response.writeHead(401).end(); return }
    if (request.method !== 'POST' || request.url !== '/') { response.writeHead(404).end(); return }
    const disconnected = new AbortController()
    response.once('close', () => disconnected.abort())
    try {
      const target = request.headers['x-amz-target']
      const body = await requestJson(request)
      if (target === 'KiroRuntimeService.GenerateAssistantResponse') {
        finishReason = await forwardInference(body, response, upstream, model, AbortSignal.any([signal, disconnected.signal]))
        return
      }
      let result
      if (target === 'KiroControlPlaneBearerService.ListAvailableModels') {
        listed = true
        result = { models: [{
          modelId: scopedModelId, modelName: model.model, description: 'Model selected in Studio',
          inputTypes: ['TEXT', 'IMAGE'],
          ...(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { maxInputTokens: model.contextWindow } : {}),
          ...(Number.isSafeInteger(model.outputLimit) && model.outputLimit > 0 ? { maxOutputTokens: model.outputLimit } : {}),
        }] }
      } else if (target === 'KiroRuntimeService.InvokeMCP') {
        result = { jsonrpc: '2.0', id: body.id, result: { tools: [] } }
      } else if (preferenceOperations.has(target)) {
        result = {}
      } else {
        response.writeHead(400, { 'content-type': kasJson }).end(JSON.stringify({ __type: 'ValidationException', message: 'Unsupported local operation' }))
        return
      }
      response.writeHead(200, { 'content-type': kasJson }).end(JSON.stringify(result))
    } catch {
      if (response.destroyed) return
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': kasJson }).end(JSON.stringify({ __type: 'InternalServerException', message: 'Studio model request failed' }))
      } else {
        response.end(kasEvent('internalServerException', { message: 'Studio model stream failed' }, 'exception'))
      }
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    endpoint: 'http://127.0.0.1:' + server.address().port,
    get listed() { return listed },
    get finishReason() { return finishReason },
    auth: () => ({ accessToken: key, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), profileArn, provider: 'Github' }),
    dispose: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
  }
}

async function copyNativeResources(source, directory, settings, signal) {
  const inspect = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  const skills = join(source, 'skills')
  const mcp = join(source, 'settings', 'mcp.json')
  const [skillInfo, mcpInfo] = await Promise.all([inspect(skills), inspect(mcp)])
  if (skillInfo?.isDirectory()) {
    await symlink(skills, join(directory, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  if (mcpInfo?.isFile() && mcpInfo.size <= 1024 * 1024) {
    const bytes = await readFile(mcp, { signal })
    if (bytes.length <= 1024 * 1024) await writeFile(join(settings, 'mcp.json'), bytes, { mode: 0o600, signal })
  }
}

export async function createScopedConfig(model, runtimeDir, signal, nativeRoot) {
  signal.throwIfAborted()
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(runtimeDir, 'kiro-scoped-'))
  let proxy
  const dispose = async () => {
    try { await proxy?.dispose() }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }) }
  }
  try {
    const settings = join(directory, 'settings')
    await mkdir(settings, { mode: 0o700 })
    await writeFile(join(settings, 'cli.json'), '{"telemetry.enabled":false}', { mode: 0o600, signal })
    if (nativeRoot) await copyNativeResources(nativeRoot, directory, settings, signal)
    proxy = await startProxy(model, signal)
    signal.throwIfAborted()
    const env = childEnvironment()
    delete env.KIRO_DEFAULT_SETTINGS
    const noProxy = [env.NO_PROXY ?? env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
    return {
      proxy, dispose,
      env: {
        ...env, KIRO_HOME: directory, KIRO_KAS_ENDPOINT: proxy.endpoint, KIRO_KAS_CONTROL_PLANE_ENDPOINT: proxy.endpoint,
        KIRO_DISABLE_TELEMETRY: '1', KIRO_NO_AUTO_UPDATE: '1', NO_PROXY: noProxy, no_proxy: noProxy,
      },
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
