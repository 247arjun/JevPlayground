import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { atomicJson, errorCode, hash, readBounded, relativePath } from '../src/security.js'

test('path policy rejects traversal, platform escapes and symlinks', async () => {
  for (const value of ['../outside', '/etc/passwd', 'C:/secrets', 'a\\b', 'a/../b', 'a//b', 'a\0b']) {
    assert.throws(() => relativePath(value), /invalid_relative_path/)
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-path-'))
  try {
    await mkdir(path.join(root, 'source'))
    await writeFile(path.join(root, 'source/code.ts'), 'const value = 1')
    assert.equal((await readBounded(root, 'source/code.ts', 100)).toString(), 'const value = 1')
    await assert.rejects(readBounded(root, 'source/code.ts', 2), /file_size_limit/)
    await symlink(path.join(root, 'source'), path.join(root, 'link'))
    await assert.rejects(readBounded(root, 'link/code.ts', 100), /symlink_not_allowed/)
    await atomicJson(path.join(root, 'result.json'), { complete: true })
    assert.deepEqual(JSON.parse((await readBounded(root, 'result.json', 100)).toString()), { complete: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('hashing and logs never expose arbitrary exception text', () => {
  assert.equal(hash('value').length, 64)
  assert.equal(errorCode(new Error('network_failed')), 'network_failed')
  assert.equal(errorCode(new Error('Authorization: Bearer secret')), 'operation_failed')
})