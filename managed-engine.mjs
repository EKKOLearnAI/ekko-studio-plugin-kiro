import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { childEnvironment, engineVersion, executablePath, findEngine } from './engine.mjs'

const base = 'https://prod.download.cli.kiro.dev/stable/'
const versionPattern = /^\d+\.\d+\.\d+$/
const releasePattern = /^release-[a-zA-Z0-9]+$/
const limit = 1024 * 1024 * 1024
const external = 'This Kiro CLI installation is managed outside Studio.'
const operations = new Map()

export function packageName(platform = process.platform, arch = process.arch, glibc = process.report?.getReport().header.glibcVersionRuntime) {
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) return 'kirocli-universal-darwin.zip'
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch]
  if (platform !== 'linux' || !cpu) return undefined
  const [major, minor] = (glibc ?? '').split('.').map(Number)
  const gnu = major > 2 || major === 2 && minor >= (arch === 'arm64' ? 39 : 34)
  return 'kirocli-' + cpu + '-linux' + (gnu ? '' : '-musl') + '.zip'
}

export function publishedPackage(manifest, name) {
  const { version, packages } = manifest ?? {}
  if (typeof version !== 'string' || !versionPattern.test(version) || Number(version.split('.')[0]) < 3 || !Array.isArray(packages)) {
    throw new Error('Kiro did not publish a valid stable release manifest.')
  }
  const path = version + '/' + name
  const item = packages.find(candidate => candidate?.download === path && candidate.fileType === 'zip')
  if (typeof item?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > limit) {
    throw new Error('Kiro did not publish a checksummed CLI archive for this host.')
  }
  return { version, path, size: item.size, sha256: item.sha256 }
}

async function latest(name, signal) {
  try {
    const response = await fetch(base + 'latest/manifest.json', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
    })
    if (!response.ok) throw new Error()
    return publishedPackage(await response.json(), name)
  } catch {
    signal.throwIfAborted()
    throw new Error('Could not check the official Kiro CLI release for this platform.')
  }
}

async function download(release, path, signal) {
  const response = await fetch(base + release.path, { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('Could not download Kiro CLI.')
  const digest = createHash('sha256')
  let size = 0
  const verify = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length
      if (size > release.size) return done(new Error('The Kiro download exceeds its published size.'))
      digest.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
  if (size !== release.size || digest.digest('hex') !== release.sha256) {
    throw new Error('The Kiro CLI download did not match its published checksum.')
  }
}

async function extract(archive, destination, signal) {
  const child = spawn('unzip', ['-p', archive, 'kirocli/bin/kiro-cli'], {
    env: childEnvironment(), signal, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not extract the Kiro binary.')))
  })
  try {
    await Promise.all([exited, pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o700 }), { signal })])
  } catch {
    child.kill()
    signal.throwIfAborted()
    throw new Error('Could not extract the Kiro binary. Ensure unzip is installed on the Studio host.')
  }
  await chmod(destination, 0o700)
}

async function selectedRelease(root) {
  let value
  try { value = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (value === null || typeof value === 'string' && releasePattern.test(value)) return value
  throw new Error('Invalid Kiro CLI engine selection.')
}

async function selectRelease(root, value) {
  const temporary = join(root, '.selection-' + randomUUID())
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(root, 'current.json'))
  } finally { await rm(temporary, { force: true }) }
}

function serialize(root, task) {
  const previous = operations.get(root) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  operations.set(root, current)
  return current.finally(() => { if (operations.get(root) === current) operations.delete(root) })
}

const cleanup = path => rm(path, { force: true, recursive: true, maxRetries: 3 })

export function managedEngine(dataDir) {
  const root = join(dataDir, 'engine')
  const archiveName = packageName()

  async function resolve() {
    if (process.env.EKKO_KIRO_EXECUTABLE?.trim()) return { engine: await findEngine(), source: 'external' }
    const release = await selectedRelease(root)
    if (release) return { engine: await executablePath(join(root, release, 'kiro-cli')), source: 'managed' }
    if (release === null) return { source: 'managed' }
    const engine = await findEngine()
    return { engine, source: engine ? 'external' : archiveName ? 'managed' : 'not-installed' }
  }

  async function status(signal) {
    try {
      signal.throwIfAborted()
      const { engine, source } = await resolve()
      if (!engine) return { installed: false, version: '', source: source === 'external' ? 'not-installed' : source }
      const version = await engineVersion(engine, signal)
      if (version) return { installed: true, version, source }
      return {
        installed: false, version: '', source: source === 'external' ? 'not-installed' : source,
        error: 'Kiro CLI 3.0 or later is required. Update the installed executable.',
      }
    } catch {
      signal.throwIfAborted()
      return { installed: false, version: '', source: 'error', error: 'Could not read or start Kiro CLI.' }
    }
  }

  async function checkUpdate(run) {
    const current = await status(run.signal)
    if (current.source !== 'managed') {
      return { currentVersion: current.version, latestVersion: current.version, updateAvailable: false, message: external }
    }
    const { version } = await latest(archiveName, run.signal)
    return { currentVersion: current.version, latestVersion: version, updateAvailable: current.version !== version }
  }

  function upgrade(input, run) {
    return serialize(root, async () => {
      if (!archiveName || (await resolve()).source !== 'managed') throw new Error(external)
      const current = await status(run.signal)
      if (current.version !== input.expectedVersion) throw new Error('Kiro CLI version changed. Check for updates again.')
      const release = await latest(archiveName, run.signal)
      if (input.version !== release.version) throw new Error('Kiro published a new stable version. Check for updates again.')
      const previous = await selectedRelease(root)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const stage = await mkdtemp(join(root, 'release-'))
      let selected = false
      try {
        const archive = join(stage, archiveName)
        const engine = join(stage, 'kiro-cli')
        run.progress({ message: 'Downloading Kiro CLI', percent: 15 })
        await download(release, archive, run.signal)
        run.progress({ message: 'Verifying the Kiro CLI binary', percent: 82 })
        await extract(archive, engine, run.signal)
        const version = await engineVersion(engine, run.signal)
        if (version !== release.version) throw new Error('The extracted Kiro CLI has an unexpected version.')
        await rm(archive)
        run.signal.throwIfAborted()
        await selectRelease(root, basename(stage))
        selected = true
        if (previous) await cleanup(join(root, previous)).catch(() => {})
        return { installedVersion: version }
      } finally {
        if (!selected) await cleanup(stage).catch(() => {})
      }
    })
  }

  function remove(run) {
    return serialize(root, async () => {
      if ((await resolve()).source !== 'managed') throw new Error(external)
      const release = await selectedRelease(root)
      if (!release) return
      run.signal.throwIfAborted()
      await selectRelease(root, null)
      await cleanup(join(root, release)).catch(() => {})
    })
  }

  return { resolve, status, checkUpdate, upgrade, remove }
}
