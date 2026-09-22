import assert from 'node:assert/strict'
import test from 'node:test'
import { sandboxArguments, validationPlanSchema } from '../src/validation.js'

test('validation requires pinned images and restrictive container boundaries', () => {
  const raw = { taskId: 'a'.repeat(64), snapshotId: 'b'.repeat(64), image: 'node@sha256:' + 'c'.repeat(64), command: ['node', '/snapshot/test.js'], timeoutMs: 5000, expectedObservation: 'Expected invariant observed' }
  const plan = validationPlanSchema.parse(raw)
  const args = sandboxArguments(plan, '/tmp/snapshot', 'test')
  for (const expected of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '65534:65534']) assert.ok(args.includes(expected))
  assert.ok(!args.some(value => value.includes('docker.sock') || value === '--privileged'))
  assert.throws(() => validationPlanSchema.parse({ ...raw, image: 'node:latest' }))
  assert.throws(() => sandboxArguments(plan, '/tmp/bad,path', 'test'), /unsupported_mount_path/)
})