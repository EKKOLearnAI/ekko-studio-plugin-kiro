// Configuration editing adapted from the MIT-licensed Ekko Studio MiniMax Code plugin.
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMap, parseDocument } from './vendor-yaml.mjs'

const fileLimit = 1024 * 1024
const disabledSkill = 'SKILL.md.studio-disabled'
const mask = '••••••••'
const reserved = new Set(['__proto__', 'constructor', 'prototype'])
const deviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const queue = new Map()
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const skillName = name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64 && !deviceName.test(name) && !reserved.has(name)
const mcpName = name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) && !reserved.has(name)

async function inspect(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function readText(path) {
  const entry = await inspect(path)
  if (!entry) return undefined
  if (!entry.isFile() || entry.size > fileLimit) throw new Error('Configuration must be a regular file of at most 1 MiB.')
  return readFile(path, 'utf8')
}

async function atomicWrite(path, text, mode = 0o600) {
  if (Buffer.byteLength(text) > fileLimit) throw new Error('Configuration exceeds 1 MiB.')
  const temp = join(dirname(path), `.studio-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, text, { mode, flag: 'wx' })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

function mutate(path, work) {
  const previous = queue.get(path) || Promise.resolve()
  const next = previous.catch(() => {}).then(work)
  queue.set(path, next)
  return next.finally(() => { if (queue.get(path) === next) queue.delete(path) })
}

function expectRevision(expected, current) {
  if (expected !== current) throw new Error('This configuration changed. Refresh it before editing.')
}

function parseYaml(text) {
  try {
    const document = parseDocument(text)
    if (!document.errors.length && (document.contents === null || isMap(document.contents))) {
      return { document, value: document.toJS({ maxAliasCount: 20 }) ?? {} }
    }
  } catch { /* Avoid returning fragments of configuration containing credentials. */ }
  throw new Error('Expected valid YAML containing a mapping.')
}

function skillMetadata(markdown, name) {
  const frontmatter = skillHeader(markdown)
  if (!frontmatter || frontmatter.index !== 0) throw new Error('SKILL.md requires YAML frontmatter with name and description.')
  const { value: metadata } = parseYaml(frontmatter[1])
  if (metadata.name !== name || typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error('The frontmatter name must match the skill directory, and description is required.')
  }
  return metadata.description.trim()
}

function skillHeader(markdown) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(markdown)
  return match?.index === 0 ? match : undefined
}

async function skillFiles(directory, name) {
  const folder = join(directory, name)
  const entry = await inspect(folder)
  if (entry && !entry.isDirectory()) return { readOnly: true }
  const active = join(folder, 'SKILL.md')
  const disabled = join(folder, disabledSkill)
  const [a, d] = await Promise.all([inspect(active), inspect(disabled)])
  if (a && d || a && !a.isFile() || d && !d.isFile()) return { readOnly: true }
  return { folder, active, disabled, file: a ? active : d ? disabled : undefined, enabled: Boolean(a) }
}

async function readSkill(directory, name) {
  const files = await skillFiles(directory, name)
  if (files.readOnly) throw new Error('This Skill points outside the editable directory or has conflicting files.')
  if (!files.file) return { name, markdown: '', enabled: true, revision: '' }
  const markdown = await readText(files.file)
  if (markdown === undefined) throw new Error('This Skill changed. Refresh it before editing.')
  return { name, markdown, enabled: files.enabled, revision: hash(`${files.enabled}:\n${markdown}`) }
}

function validateMcp(config) {
  const { command, url: address, args, env, headers } = config
  if (address === undefined) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('A stdio server requires a command.')
  } else {
    let url
    try { if (typeof address === 'string') url = new URL(address) } catch { /* Report a configuration error below. */ }
    if (!['http:', 'https:'].includes(url?.protocol) || command !== undefined) {
      throw new Error('A remote MCP server requires an HTTP(S) URL.')
    }
  }
  if (args !== undefined && (!Array.isArray(args) || args.some(item => typeof item !== 'string'))) {
    throw new Error('MCP args must be a list of strings.')
  }
  for (const [key, value] of Object.entries({ env, headers })) {
    if (value !== undefined && (!record(value) || Object.values(value).some(item => typeof item !== 'string'))) {
      throw new Error(`MCP ${key} must be a mapping of strings.`)
    }
  }
  if (Object.hasOwn(config, 'disabled') || Object.hasOwn(config, 'enabled')) throw new Error('Use the enabled switch for this server.')
  return config
}

function hideSecrets(value, key = '', all = false) {
  if (/^(?:auth|oauth|oauthState)$/i.test(key) && value !== undefined) return mask
  if (Array.isArray(value)) return value.map(item => hideSecrets(item, key, all))
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) =>
    [name, hideSecrets(item, name, all || key === 'env' || key === 'headers')]))
  if (typeof value !== 'string' || !value) return value
  if (all || /(?:authorization|cookie|password|secret|token|api[-_]?key|credential)/i.test(key)) return mask
  if (/(?:url|uri)$/i.test(key)) {
    try {
      const url = new URL(value)
      if (url.username || url.password || url.search || url.hash) return mask
    } catch { /* Invalid values may still be edited. */ }
  }
  return value
}

function restoreSecrets(value, previous) {
  if (value === mask) {
    if (previous === undefined) throw new Error('Replace the masked value with a new value.')
    return previous
  }
  if (Array.isArray(value)) return value.map((item, index) => restoreSecrets(item, previous?.[index]))
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, restoreSecrets(item, record(previous) ? own(previous, key) : undefined)]))
  return value
}

async function readMcp(file) {
  const text = await readText(file)
  if (text === undefined) return { mcpServers: {} }
  try {
    const value = JSON.parse(text)
    if (record(value) && (value.mcpServers === undefined || record(value.mcpServers))) {
      return { ...value, mcpServers: value.mcpServers ?? {} }
    }
  } catch { /* Report a generic error without credentials. */ }
  throw new Error('Kiro MCP settings must contain a JSON object with an mcpServers mapping.')
}

function mcpRevision(value) {
  return value === undefined ? '' : hash(JSON.stringify(value))
}

function readSettings(raw) {
  if (raw === undefined) return {}
  try {
    const value = JSON.parse(raw)
    if (record(value)) return value
  } catch { /* Native settings may contain credentials. */ }
  throw new Error('Kiro cli.json must contain a JSON object.')
}

export function nativeConfiguration(root) {
  const skillDir = join(root, 'skills')
  const settingsDir = join(root, 'settings')
  const mcpFile = join(settingsDir, 'mcp.json')
  const settingsFile = join(settingsDir, 'cli.json')

  async function checkDirectories() {
    for (const directory of [root, settingsDir]) {
      const entry = await inspect(directory)
      if (entry && !entry.isDirectory()) throw new Error('Kiro configuration directories must be local directories.')
    }
  }

  async function checkSkillRoot() {
    await checkDirectories()
    const entry = await inspect(skillDir)
    if (entry && !entry.isDirectory()) throw new Error('The native Skill directory must be a local directory.')
    return Boolean(entry)
  }

  const api = {
    async listSkills() {
      const items = []
      if (await checkSkillRoot()) {
        for (const name of (await readdir(skillDir)).sort()) {
          if (!skillName(name)) continue
          const files = await skillFiles(skillDir, name)
          if (files.readOnly) {
            items.push({ name, enabled: false, description: '', readOnly: true })
          } else if (files.file) {
            let description = ''
            try {
              const markdown = await readText(files.file)
              description = skillMetadata(markdown || '', name).slice(0, 2000)
            } catch { /* Incomplete frontmatter remains editable. */ }
            items.push({ name, enabled: files.enabled, description, readOnly: false })
          }
        }
      }
      return { directory: skillDir, items }
    },
    async getSkill({ name }) {
      if (!skillName(name)) throw new Error('Use a lowercase Skill name with letters, numbers and hyphens.')
      await checkSkillRoot()
      return readSkill(skillDir, name)
    },
    async editSkill({ name, description, content, enabled, revision }) {
      const current = await api.getSkill({ name })
      expectRevision(revision, current.revision)
      if (!description.trim() || !content.trim()) throw new Error('A Skill requires a description and Markdown content.')
      const header = skillHeader(current.markdown)
      let frontmatter
      try { frontmatter = parseYaml(header?.[1] ?? '').document }
      catch { frontmatter = parseYaml('').document }
      frontmatter.set('name', name)
      frontmatter.set('description', description.trim())
      const yaml = frontmatter.toString({ lineWidth: 0, directives: false })
      const previousBody = header ? current.markdown.slice(header[0].length).replace(/^\r?\n/, '') : current.markdown
      const unchanged = current.markdown && (() => {
        try { return skillMetadata(current.markdown, name) === description.trim() && previousBody === content }
        catch { return false }
      })()
      return api.saveSkill({ name, enabled, revision, markdown: unchanged ? current.markdown : `---\n${yaml}---\n\n${content}` })
    },
    saveSkill({ name, markdown, enabled, revision }) {
      if (!skillName(name)) throw new Error('Use a lowercase Skill name with letters, numbers and hyphens.')
      skillMetadata(markdown, name)
      return mutate(skillDir, async () => {
        await checkSkillRoot()
        const current = await readSkill(skillDir, name)
        expectRevision(revision, current.revision)
        const files = await skillFiles(skillDir, name)
        if (files.readOnly) throw new Error('This Skill is read-only.')
        await mkdir(files.folder, { recursive: true, mode: 0o700 })
        const target = enabled ? files.active : files.disabled
        if (files.file && files.file !== target) {
          if (markdown !== current.markdown) await atomicWrite(files.file, markdown)
          await rename(files.file, target)
        } else {
          await atomicWrite(target, markdown)
        }
        return { ok: true }
      })
    },
    removeSkill({ name, revision }) {
      if (!skillName(name)) throw new Error('Invalid Skill name.')
      return mutate(skillDir, async () => {
        await checkSkillRoot()
        const current = await readSkill(skillDir, name)
        expectRevision(revision, current.revision)
        const { file, folder } = await skillFiles(skillDir, name)
        if (file) {
          await rm(file)
          await rmdir(folder).catch(error => { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error })
        }
        return { ok: true }
      })
    },
    async listMcp() {
      await checkDirectories()
      const { mcpServers } = await readMcp(mcpFile)
      const items = Object.entries(mcpServers).filter(([name]) => mcpName(name)).map(([name, value]) => {
        const { disabled, ...config } = record(value) ? value : {}
        return { name, enabled: disabled !== true, config: hideSecrets(config), revision: mcpRevision(value) }
      })
      return { path: mcpFile, items }
    },
    saveMcp({ name, config, enabled, revision }) {
      if (!mcpName(name)) throw new Error('Use an MCP name with letters, numbers, underscores, dots or hyphens.')
      return mutate(mcpFile, async () => {
        await checkDirectories()
        const document = await readMcp(mcpFile)
        const previous = own(document.mcpServers, name)
        expectRevision(revision, mcpRevision(previous))
        const next = validateMcp(restoreSecrets(config, previous))
        document.mcpServers[name] = { ...next, ...(!enabled ? { disabled: true } : {}) }
        await mkdir(dirname(mcpFile), { recursive: true, mode: 0o700 })
        await atomicWrite(mcpFile, `${JSON.stringify(document, null, 2)}\n`)
        return { ok: true }
      })
    },
    removeMcp({ name, revision }) {
      if (!mcpName(name)) throw new Error('Invalid MCP name.')
      return mutate(mcpFile, async () => {
        await checkDirectories()
        const document = await readMcp(mcpFile)
        const previous = own(document.mcpServers, name)
        expectRevision(revision, mcpRevision(previous))
        if (previous !== undefined) {
          delete document.mcpServers[name]
          await atomicWrite(mcpFile, `${JSON.stringify(document, null, 2)}\n`)
        }
        return { ok: true }
      })
    },
    async getSettingsEditor() {
      await checkDirectories()
      const raw = await readText(settingsFile)
      return { revision: hash(raw ?? ''), path: settingsFile, config: hideSecrets(readSettings(raw)) }
    },
    saveSettingsEditor({ revision, config }) {
      return mutate(settingsFile, async () => {
        await checkDirectories()
        const raw = await readText(settingsFile)
        expectRevision(revision, hash(raw ?? ''))
        const before = readSettings(raw)
        const after = restoreSecrets(config, before)
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          await mkdir(settingsDir, { recursive: true, mode: 0o700 })
          await atomicWrite(settingsFile, JSON.stringify(after, null, 2) + '\n')
        }
        return { ok: true }
      })
    },
  }
  return api
}
