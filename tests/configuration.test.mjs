import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeConfiguration } from '../native-config.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'kiro-config-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, config: nativeConfiguration(root) }
}

test('edits Kiro Skills without losing native metadata or companion files', async t => {
  const { root, config } = await setup(t)
  const name = 'release-notes'
  const folder = join(root, 'skills', name)
  const skill = join(folder, 'SKILL.md')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'example.md'), 'companion')
  await writeFile(skill, '---\nname: release-notes\ndescription: Draft notes\nlicense: MIT\n---\n\nBody\n')
  const original = await config.getSkill({ name })
  await config.editSkill({ name, description: 'Prepare notes', content: 'Updated body', enabled: false, revision: original.revision })
  assert.match(await readFile(skill + '.studio-disabled', 'utf8'), /license: MIT/)
  assert.deepEqual((await config.listSkills()).items, [{ name, description: 'Prepare notes', enabled: false, readOnly: false }])
  await assert.rejects(config.removeSkill({ name, revision: original.revision }), /configuration changed/)
  await config.removeSkill({ name, revision: (await config.getSkill({ name })).revision })
  assert.equal(await readFile(join(folder, 'example.md'), 'utf8'), 'companion')
})

test('masks native MCP and CLI secrets, retains masked values, and checks revisions', async t => {
  const { root, config } = await setup(t)
  const settings = join(root, 'settings')
  const mcp = join(settings, 'mcp.json')
  const cli = join(settings, 'cli.json')
  await mkdir(settings)
  await writeFile(mcp, JSON.stringify({ mcpServers: { remote: {
    url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private' },
    oauth: { accessToken: 'private-oauth' },
  } }, identityProvider: { mode: 'test' } }))
  await writeFile(cli, JSON.stringify({ 'telemetry.enabled': true, custom: { apiKey: 'private-key' } }))
  const entry = (await config.listMcp()).items[0]
  assert.doesNotMatch(JSON.stringify(entry), /private/)
  await config.saveMcp({ ...entry, enabled: false })
  const saved = JSON.parse(await readFile(mcp, 'utf8'))
  assert.equal(saved.mcpServers.remote.disabled, true)
  assert.equal(saved.mcpServers.remote.headers.Authorization, 'Bearer private')
  assert.equal(saved.mcpServers.remote.oauth.accessToken, 'private-oauth')
  assert.deepEqual(saved.identityProvider, { mode: 'test' })
  await assert.rejects(config.removeMcp(entry), /configuration changed/)

  const editor = await config.getSettingsEditor()
  assert.doesNotMatch(JSON.stringify(editor), /private-key/)
  await config.saveSettingsEditor({ revision: editor.revision, config: { ...editor.config, 'telemetry.enabled': false } })
  assert.deepEqual(JSON.parse(await readFile(cli, 'utf8')), { 'telemetry.enabled': false, custom: { apiKey: 'private-key' } })
  await assert.rejects(config.saveSettingsEditor({ revision: editor.revision, config: {} }), /configuration changed/)
})
