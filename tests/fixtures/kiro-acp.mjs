#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  console.log('kiro-cli 3.5.0')
  process.exit(0)
}
assert.deepEqual(process.argv.slice(2), ['acp', '--agent-engine=v3'])
const mode = basename(process.cwd())
const sessionId = 'fixture-session'
let model = 'model-a'
let promptId
let inputs
const send = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }))
const reply = (id, result) => send({ id, result })
const update = (value, session = sessionId) => send({ method: 'session/update', params: { sessionId: session, update: value } })
const options = () => [{ type: 'select', id: 'model', currentValue: model, options: [
  { group: 'Kiro models', name: 'Kiro models', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
] }]

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line)
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: 1, agentInfo: { name: 'Kiro CLI Agent' },
        agentCapabilities: { promptCapabilities: { image: true }, mcpCapabilities: { http: true } } })
      break
    case 'session/new':
      assert.equal(params.cwd, process.cwd())
      if (mode === 'mcp') assert.deepEqual(params.mcpServers, [
        { name: 'studio', command: 'node', args: ['studio.mjs'], env: [{ name: 'TEST', value: '1' }] },
        { name: 'remote', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'test' }] },
      ])
      inputs = params.additionalDirectories
      reply(id, { sessionId, configOptions: options() })
      break
    case 'session/set_config_option':
      if (mode !== 'mismatch') model = params.value
      reply(id, { configOptions: options() })
      break
    case 'session/prompt':
      promptId = id
      if (mode === 'cancel') {
        await writeFile(join(process.cwd(), 'prompt-ready'), 'ready')
        break
      }
      if (mode === 'attachments') {
        const photo = params.prompt.find(item => item.type === 'image')
        assert.equal(Buffer.from(photo.data, 'base64').toString(), 'image bytes')
        assert.equal(params.prompt.filter(item => item.type === 'image').length, 1)
        const file = params.prompt.find(item => item.text?.includes('Available at'))
        const path = JSON.parse(file.text.match(/Available at (".*?")\./)[1])
        assert.equal(path.startsWith(inputs[0]), true)
        assert.equal(await readFile(path, 'utf8'), 'file bytes')
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } }, 'foreign')
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' }, _meta: { kiro: { replay: true } } })
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'summary' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool', kind: 'execute', status: 'in_progress' })
      send({ id: 100, method: 'session/request_permission', params: { sessionId, toolCall: {
        toolCallId: 'tool', title: 'Shell', rawInput: { command: 'echo check' },
      }, options: [
        { optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' },
        { optionId: 'always', kind: 'allow_always' },
      ] } })
      break
    case 'session/cancel':
      await writeFile(join(process.cwd(), 'cancelled'), params.sessionId)
      reply(promptId, { stopReason: 'cancelled' })
      break
    default:
      if (id === 100) {
        const decision = result.outcome.optionId ?? result.outcome.outcome
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: model + ':' + decision } })
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: decision === 'allow' ? 'completed' : 'failed' })
        reply(promptId, { stopReason: 'end_turn' })
      }
  }
}
