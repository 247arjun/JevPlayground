import assert from 'node:assert/strict'
import test from 'node:test'
import { bounded, permission, sessionConfiguration } from '../src/copilot/client.js'

test('session permissions fail closed for unknown, builtin, managed and network tools', () => {
  const names = new Set(['read_source'])
  assert.equal(permission({ kind: 'custom-tool', toolName: 'read_source' }, names).kind, 'approve-once')
  for (const kind of ['shell', 'write', 'read', 'url', 'mcp', 'hook', 'memory', 'unknown']) assert.equal(permission({ kind, toolName: 'read_source' }, names).kind, 'reject')
  assert.equal(permission({ kind: 'custom-tool', toolName: 'read_source', managedApprovalRequired: true }, names).kind, 'reject')
  const config = sessionConfiguration('/tmp/isolated', 'test', [], 'test')
  assert.equal(config.enableConfigDiscovery, false)
  assert.equal(config.skipCustomInstructions, true)
  assert.deepEqual(config.memory, { enabled: false })
  assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*'])
})

test('deadline invokes runtime cancellation and rejects without accepting late completion', async () => {
  let aborted = false
  await assert.rejects(bounded(new Promise(() => {}), 5, async () => { aborted = true }), /model_timeout/)
  assert.equal(aborted, true)
  assert.equal(await bounded(Promise.resolve(42), 100, async () => {}), 42)
})