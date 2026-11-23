import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
const binary = windows ? 'kiro-cli.exe' : 'kiro-cli'
const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|USER|LOGNAME|USERNAME|XDG_(DATA|CONFIG|RUNTIME|CACHE|STATE)_(HOME|DIR)|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|AWS_CA_BUNDLE|KIRO_RUNTIME_DIR|KIRO_DEFAULT_SETTINGS)$/i

export function nativeConfigDir(env = process.env) {
  const home = homedir()
  const configured = env.KIRO_HOME
  if (configured && isAbsolute(configured)) {
    const candidate = resolve(configured)
    const fromCandidate = relative(candidate, home)
    if (fromCandidate && (fromCandidate === '..' || fromCandidate.startsWith('..' + (windows ? '\\' : '/')) || isAbsolute(fromCandidate))) {
      return candidate
    }
  }
  return join(home, '.kiro')
}

export function childEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)))
  return { ...env, KIRO_HOME: nativeConfigDir(source), KIRO_LOG_NO_COLOR: '1' }
}

export async function executablePath(path) {
  if (!path || !isAbsolute(path)) return undefined
  try {
    await access(path, constants.X_OK)
    const target = await realpath(path)
    if ((await stat(target)).isFile()) return target
  } catch { /* Try the next installed location. */ }
}

export async function findEngine(source = process.env) {
  const override = source.EKKO_KIRO_EXECUTABLE?.trim()
  if (override) return executablePath(override)
  const path = Object.entries(source).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  const candidates = path.split(delimiter).filter(isAbsolute).map(dir => join(dir, binary))
  candidates.push(join(homedir(), '.local', 'bin', binary))
  if (windows) {
    for (const root of [source.LOCALAPPDATA, source.ProgramFiles]) {
      if (root) candidates.push(join(root, 'Programs', 'Kiro', 'CLI', binary), join(root, 'Kiro', 'CLI', binary), join(root, 'Kiro CLI', binary))
    }
  } else {
    candidates.push('/usr/local/bin/kiro-cli', '/opt/homebrew/bin/kiro-cli')
  }
  for (const candidate of new Set(candidates)) {
    const engine = await executablePath(candidate)
    if (engine) return engine
  }
}

export async function engineVersion(engine, signal) {
  try {
    const { stdout } = await exec(engine, ['--version'], {
      env: childEnvironment(), signal, timeout: 8000, maxBuffer: 8192, windowsHide: true,
    })
    const version = /^kiro-cli\s+(\d+\.\d+\.\d+)$/i.exec(stdout.trim())?.[1]
    if (version && Number(version.split('.')[0]) >= 3) return version
  } catch { signal.throwIfAborted() }
}

export function loginCommand(engine) {
  if (!engine) return ''
  if (windows) {
    const quote = value => "'" + value.replaceAll("'", "''") + "'"
    return '$env:KIRO_HOME = ' + quote(nativeConfigDir()) + '; & ' + quote(engine) + ' login'
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  return 'KIRO_HOME=' + quote(nativeConfigDir()) + ' ' + quote(engine) + ' login'
}
