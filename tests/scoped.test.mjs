import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../server.mjs'
import { createScopedConfig, scopedModelId, scopedRequest } from '../scoped.mjs'

const native = process.env.EKKO_KIRO_NATIVE_TEST_CLI
const runtimeIdentity = { userId: 1, profile: 'default', agentId: 'plugin:kiro/kiro' }
const lifecycle = { add() {} }

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-scoped-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function startServer(t, handler) {
  const server = createServer(handler)
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  return 'http://127.0.0.1:' + server.address().port
}

function bindModel(baseUrl, label = 'selected-model') {
  return { provider: 'fixture-provider', model: label, apiMode: 'chat_completions',
    baseUrl: baseUrl + '/v1', token: 'studio-lease-' + label, contextWindow: 14000, outputLimit: 2000 }
}

test('rejects an unauthenticated caller and a request for any other model', async t => {
  const path = await temp(t)
  let forwarded = false
  const upstream = await startServer(t, (_req,res) => { forwarded = true; res.end() })
  const config = await createScopedConfig(bindModel(upstream), path, new AbortController().signal)
  t.after(config.dispose)
  assert.equal(config.env.KIRO_KAS_ENDPOINT, config.env.KIRO_KAS_CONTROL_PLANE_ENDPOINT)
  const headers = { 'x-amz-target': 'KiroRuntimeService.GenerateAssistantResponse' }
  assert.equal((await fetch(config.proxy.endpoint, { method: 'POST', headers, body: '{}' })).status, 401)
  headers.Authorization = 'Bearer ' + config.proxy.auth().accessToken
  assert.doesNotMatch(JSON.stringify(config.proxy.auth()), /studio-lease/)
  assert.equal((await fetch(config.proxy.endpoint, { method: 'POST', headers, body: '{}' })).status, 502)
  assert.equal(forwarded, false)
})

test('maps native tool history back to the selected model and preserves its image input', () => {
  const model = bindModel('http://127.0.0.1:1')
  const request = scopedRequest({
    history: [{ assistantResponseMessage: { toolUses: [{ toolUseId: 'call-id', name: 'read_file', input: { path: 'note.txt' } }] } }],
    currentMessage: { userInputMessage: { modelId: scopedModelId, content: 'Read the attachment',
      images: [{ format: 'png', source: { bytes: 'QUJD' } }], userInputMessageContext: { toolResults: [
        { toolUseId: 'call-id', content: [{ text: 'file content' }], status: 'success' },
      ] },
    } },
  }, model)
  assert.equal(request.model, model.model)
  assert.equal(request.messages[0].tool_calls[0].id, 'call-id')
  assert.deepEqual(request.messages[1], { role: 'tool', tool_call_id: 'call-id', content: 'file content' })
  assert.equal(request.messages[2].content[1].image_url.url, 'data:image/png;base64,QUJD')
})

async function fixture(t, gateway) {
  const root = await temp(t)
  const overrides = {
    EKKO_KIRO_EXECUTABLE: native, KIRO_HOME: join(root, 'native'),
    HTTPS_PROXY: gateway, HTTP_PROXY: gateway, https_proxy: gateway, http_proxy: gateway,
  }
  const environment = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  t.after(() => {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  let definition
  const dispose = apply({ identity: runtimeIdentity, paths: { dataDir: root }, extensions: {
    agents: { register(value) { definition = value; return { dispose() {} } } },
    rpc: { register() { return () => {} } },
  } })
  t.after(dispose)
  return { root, definition }
}

async function turn(definition, root, model, asset) {
  const paths = { runtimeDir: join(root, 'runtime-' + model.model), workspaceDir: join(root, 'work-' + model.model) }
  await mkdir(paths.workspaceDir)
  await writeFile(join(paths.workspaceDir, 'note.txt'), 'native file result ' + model.model)
  const identity = { ...runtimeIdentity, sessionId: model.model, runId: model.model + '-run' }
  const controller = new AbortController()
  const events = []
  const run = {
    identity, paths, mode: 'scoped', model, lifecycle, signal: controller.signal, deadlineAt: Date.now() + 20_000,
    mcpServers: {}, interactions: { async approve() { return { outcome: 'approved' } } },
    output: { async emit(event) { events.push(event) } },
    attachments: {
      async resolve() { return { name: 'test.png', mediaType: 'image/png', size: asset.length } },
      async read() { return asset },
    },
  }
  const session = definition.runtime.createSession(run)
  const input = { input: [{ type: 'text', text: 'Read note.txt and inspect the attachment.' }],
    history: [], instructions: [], options: {} }
  if (asset) input.input.push({ type: 'image', assetId: 'test-image' })
  return { paths, controller, events, invoke: () => session.run(input, run), dispose: () => session.dispose() }
}

function stream(response, chunks, finishReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const data = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
  for (const delta of chunks) response.write(data(delta))
  response.end(data({}, finishReason) + 'data: [DONE]\n\n')
}

test('official Kiro CLI streams two scoped models and forwards native tools and an image without Kiro sign-in',
  { skip: !native, timeout: 30_000 }, async t => {
    const seen = []
    const upstream = await startServer(t, async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions')
        let raw = ''
        for await (const chunk of req) raw += chunk
        const input = JSON.parse(raw)
        assert.equal(req.headers.authorization, 'Bearer studio-lease-' + input.model)
        assert.equal(input.stream, true)
        assert.ok(input.tools.some(tool => tool.function.name === 'read_file'))
        const fromTool = input.messages.find(item => item.role === 'tool')
        seen.push({ model: input.model, tool: Boolean(fromTool) })
        if (fromTool) {
          assert.match(fromTool.content, new RegExp('native file result ' + input.model))
          assert.ok(input.messages.some(item => item.tool_calls?.some(call => call.id === fromTool.tool_call_id)))
          stream(res, [{ content: 'Scoped reply ' }, { content: input.model }], 'stop')
        } else {
          assert.ok(input.messages.some(item => JSON.stringify(item.content).includes('Read note.txt')))
          if (input.model === 'studio-a') assert.ok(input.messages.some(item =>
            Array.isArray(item.content) && item.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))))
          stream(res, [
            { tool_calls: [{ index: 0, id: 'read-note', function: { name: 'read_file', arguments: '{"path":' } }] },
            { tool_calls: [{ index: 0, function: { arguments: '"note.txt"}' } }] },
          ], 'tool_calls')
        }
      } catch (error) {
        seen.push(error)
        res.writeHead(500).end()
      }
    })
    const { root, definition } = await fixture(t, upstream)
    assert.deepEqual(definition.modes.scoped.protocols, ['chat_completions'])
    const image = await readFile(new URL('../assets/icon.png', import.meta.url))
    const a = await turn(definition, root, bindModel(upstream, 'studio-a'), image)
    const b = await turn(definition, root, bindModel(upstream, 'studio-b'))
    t.after(() => Promise.all([a.dispose(), b.dispose()]))
    const answers = await Promise.allSettled([a.invoke(), b.invoke()])
    const failure = seen.find(value => value instanceof Error)
    if (failure) throw failure
    assert.deepEqual(answers.map(result => result.status === 'fulfilled' ? result.value.content[0].text : result.reason.message),
      ['Scoped reply studio-a', 'Scoped reply studio-b'])
    assert.ok(seen.filter(item => item.tool).length >= 2)
    for (const run of [a, b]) {
      assert.ok(run.events.some(event => event.type === 'tool.completed'))
      assert.ok(run.events.some(event => event.type === 'text.delta'))
      assert.deepEqual(await readdir(run.paths.runtimeDir), [])
    }
  })
