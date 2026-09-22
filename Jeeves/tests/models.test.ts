import assert from 'node:assert/strict'
import test from 'node:test'
import { frameworkEvidence } from '../src/models.js'

test('Azure SDK evidence requires identifiable imports and remains declared only', () => {
  const model = frameworkEvidence('code.ts', 'import {SecretClient as Client} from "@azure/keyvault-secrets"; const client = new Client(endpoint, credentials);')
  const facts = model.facts as Array<{ family: string, kind: string }>
  assert.ok(facts.some(fact => fact.kind === 'import_linked_invocation' && fact.family === 'key_vault_secret'))
  assert.equal(model.basis, 'declared')
  assert.deepEqual(frameworkEvidence('code.ts', 'function SecretClient() {}').facts, [])
})

test('binding evidence exposes setting names but not connection-string values', () => {
  const result = frameworkEvidence('function.json', JSON.stringify({ bindings: [{ type: 'serviceBusTrigger', name: 'message', direction: 'in', connection: 'ConnectionSetting', queueName: 'jobs' }], secret: 'do-not-export' }))
  assert.ok(JSON.stringify(result).includes('ConnectionSetting'))
  assert.ok(!JSON.stringify(result).includes('do-not-export'))
  assert.ok((result.reasons as string[]).includes('deployed_settings_unknown'))
})