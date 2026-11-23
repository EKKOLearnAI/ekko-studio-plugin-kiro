import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { apply } from '../server.mjs'

const fixture = fileURLToPath(new URL('./fixtures/kiro-acp.mjs', import.meta.url))
const owner = { userId: 1, profile: 'default', agentId: 'plugin:kiro/kiro' }
const lifecycle = { add() {} }
const input = { input: [{ type: 'text', text: 'inspect this' }], history: [], instructions: [], options: {} }
const nativeFixture = { skip: process.platform === 'win32' ? 'Requires a standalone POSIX fixture executable' : false }

async function setup(t, engine = fixture) {
  const root = await mkdtemp(join(tmpdir(), 'studio-kiro-test-'))
  const env = { EKKO_KIRO_EXECUTABLE: engine, KIRO_HOME: join(root, 'kiro') }
  const prior = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  t.after(async () => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  let definition
  const rpc = new Map()
  const dispose = apply({ identity: owner, paths: { dataDir: root }, extensions: {
    agents: { register(value) { definition = value; return { dispose() {} } } },
    rpc: { register(name, handler) { rpc.set(name, handler); return () => {} } },
  } })
  t.after(dispose)
  return { root, definition, rpc }
}

async function chat(definition, root, name, { model, assets = {}, mcpServers = {} } = {}) {
  const paths = { runtimeDir: join(root, 'runtime-' + name), workspaceDir: join(root, name) }
  await mkdir(paths.workspaceDir)
  const controller = new AbortController()
  const identity = { ...owner, sessionId: name, runId: 'run-' + name }
  const events = []
  const ctx = { identity, paths, mode: 'global', model: model ? { model } : {}, lifecycle, signal: controller.signal,
    deadlineAt: Date.now() + 12_000, mcpServers,
    interactions: { async approve() { assert.fail('Tool calls must not prompt in Studio.') } },
    output: { async emit(event) { events.push(event) } },
    attachments: {
      async resolve(id) { return { ...assets[id], size: assets[id].bytes.length } },
      async read(id) { return assets[id].bytes },
    },
  }
  return { ctx, events, controller, session: definition.runtime.createSession(ctx) }
}

test('lists grouped native models and protects native access by user and Profile', nativeFixture, async t => {
  const { definition, rpc } = await setup(t)
  const ctx = { identity: owner, signal: new AbortController().signal, lifecycle }
  assert.deepEqual(await definition.getStatus(ctx), { installed: true, source: 'external', version: '3.5.0' })
  assert.deepEqual(definition.management.settings(ctx), { viewId: 'skills' })
  assert.match((await rpc.get('native-login')(null, ctx)).command, /KIRO_HOME=.* login$/)
  const catalog = await definition.modes.global.listModels(ctx)
  assert.equal(catalog.status, 'ready')
  assert.deepEqual(catalog.models, [{ id: 'model-a', name: 'Model A', isDefault: true }, { id: 'model-b', name: 'Model B' }])
  const other = { ...ctx, identity: { ...owner, profile: 'other' } }
  assert.equal((await definition.modes.global.listModels(other)).status, 'auth_required')
  assert.throws(() => definition.runtime.createSession({ ...other, mode: 'global' }), /Profile/)
  await assert.rejects(rpc.get('native-login')(null, other), /Profile/)
})

test('streams the selected model and auto-approves only offered one-time grants for the active session', nativeFixture, async t => {
  const { root, definition } = await setup(t)
  const first = await chat(definition, root, 'mcp', { model: 'model-b', mcpServers: {
    studio: { command: 'node', args: ['studio.mjs'], env: { TEST: '1' } },
    remote: { url: 'https://example.test/mcp', headers: { Authorization: 'test' } },
  } })
  const foreign = await chat(definition, root, 'foreign')
  const noAllowOnce = await chat(definition, root, 'no-allow-once')
  const result = await Promise.all([first, foreign, noAllowOnce].map(run => run.session.run(input, run.ctx)))
  assert.deepEqual(result.map(value => value.content[0].text), ['model-b:allow', 'model-a:cancelled', 'model-a:cancelled'])
  assert.deepEqual(first.events.map(event => event.type), ['reasoning.summary.delta', 'tool.started', 'text.delta', 'tool.completed'])
  assert.equal(foreign.events.at(-1).type, 'tool.failed')
  assert.equal(noAllowOnce.events.at(-1).type, 'tool.failed')
  const mismatched = await chat(definition, root, 'mismatch', { model: 'model-b' })
  await assert.rejects(mismatched.session.run(input, mismatched.ctx), /did not confirm/)
  assert.equal(mismatched.events.length, 0)
})

test('passes image and file bytes and removes private attachment staging', nativeFixture, async t => {
  const { root, definition } = await setup(t)
  const run = await chat(definition, root, 'attachments', { assets: {
    text: { name: 'file with spaces.txt', mediaType: 'text/plain', bytes: Buffer.from('file bytes') },
    image: { name: 'photo.png', mediaType: 'image/png', bytes: Buffer.from('image bytes') },
  } })
  const photo = { type: 'image', assetId: 'image' }
  const result = await run.session.run({ ...input, input: [...input.input, { type: 'file', assetId: 'text' }, photo, photo] }, run.ctx)
  assert.equal(result.content[0].text, 'model-a:allow')
  assert.deepEqual(await readdir(run.ctx.paths.runtimeDir), [])
})

test('sends native cancellation and waits for cleanup', nativeFixture, async t => {
  const { root, definition } = await setup(t)
  const run = await chat(definition, root, 'cancel')
  const pending = assert.rejects(run.session.run(input, run.ctx), /turn cancelled/)
  t.after(() => run.session.dispose())
  const ready = join(run.ctx.paths.workspaceDir, 'prompt-ready')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(ready).catch(() => null)) break
    await delay(20)
  }
  assert.ok(await stat(ready))
  run.controller.abort()
  await pending
  assert.equal(await readFile(join(run.ctx.paths.workspaceDir, 'cancelled'), 'utf8'), 'fixture-session')
})

const native = process.env.EKKO_KIRO_NATIVE_TEST_CLI
test('detects the official signed-out binary and surfaces the native login state', { skip: !native }, async t => {
  const { definition } = await setup(t, native)
  const ctx = { identity: owner, signal: new AbortController().signal, lifecycle }
  assert.equal((await definition.getStatus(ctx)).installed, true)
  assert.equal((await definition.modes.global.listModels(ctx)).status, 'auth_required')
})
