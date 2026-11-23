import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { childEnvironment, nativeConfigDir } from '../engine.mjs'
import { packageName, publishedPackage } from '../managed-engine.mjs'

test('selects the official archive based on OS, architecture and minimum glibc', () => {
  assert.equal(packageName('darwin', 'arm64'), 'kirocli-universal-darwin.zip')
  assert.equal(packageName('linux', 'x64', '2.34'), 'kirocli-x86_64-linux.zip')
  assert.equal(packageName('linux', 'arm64', '2.38'), 'kirocli-aarch64-linux-musl.zip')
  assert.equal(packageName('linux', 'arm64', '2.39'), 'kirocli-aarch64-linux.zip')
  assert.equal(packageName('win32', 'x64'), undefined)
  const name = packageName('darwin', 'arm64')
  const version = '3.5.0'
  const path = version + '/' + name
  const sha256 = 'a'.repeat(64)
  const manifest = { version, packages: [{ fileType: 'zip', download: path, sha256, size: 1234 }] }
  assert.deepEqual(publishedPackage(manifest, name), { version, path, size: 1234, sha256 })
  assert.throws(() => publishedPackage({ ...manifest, packages: [{ download: '../' + name }] }, name), /checksummed/)
})

test('uses the native Kiro profile without forwarding Studio or provider credentials', () => {
  const profile = resolve(tmpdir(), 'kiro-test')
  assert.equal(nativeConfigDir({ KIRO_HOME: parse(homedir()).root }), join(homedir(), '.kiro'))
  const env = childEnvironment({ KIRO_HOME: profile, PATH: 'test', AUTH_TOKEN: 'fake', KIRO_API_KEY: 'fake' })
  assert.equal(env.KIRO_HOME, profile)
  assert.equal(env.PATH, 'test')
  assert.equal(env.AUTH_TOKEN, undefined)
  assert.equal(env.KIRO_API_KEY, undefined)
})
