import assert from 'node:assert/strict'
import test from 'node:test'
import type { CopilotClient } from '@github/copilot-sdk'
import { CopilotBackend } from '../src/agents/runner.js'
import { bounded, permission, sessionConfiguration } from '../src/copilot/client.js'
import { defaultLimits, type AgentResult } from '../src/domain.js'
import type { Gateway } from '../src/tools/gateway.js'

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

const exhausted: AgentResult = { disposition: 'budget_exhausted', summary: 'Evidence remains incomplete.', invariant: '', operation: null, facts: [], assumptions: [], counterevidence: [], unresolved: ['No conclusion within the approved budget.'] }

test('an idle session gets one finalization turn within its original deadline', async () => {
  let finalizing = false
  let closed = false
  const prompts: string[] = []
  const deadlines: number[] = []
  const gateway = {
    accepted: undefined as AgentResult | undefined,
    tools: () => [],
    budget: () => ({ submissionCallsRemaining: 1, providerRequestsRemaining: 5 }),
    finishRetrieval: () => { finalizing = true },
    close: () => { closed = true }
  }
  const session = {
    on: () => () => {},
    sendAndWait: async ({ prompt }: { prompt: string }, milliseconds: number) => {
      prompts.push(prompt); deadlines.push(milliseconds)
      if (prompts.length === 2) { assert.equal(finalizing, true); gateway.accepted = exhausted }
    },
    abort: async () => {}, disconnect: async () => {}
  }
  const client = { createSession: async () => session } as unknown as CopilotClient
  const backend = new CopilotBackend(client, 'test-model', '/tmp/jeeves-test', { ...defaultLimits, modelTimeoutMs: 1000 })
  await backend.execute({ role: 'investigator' }, {}, gateway as unknown as Gateway, new AbortController().signal)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1]!, /No validated submit_result/)
  assert.ok(deadlines[0]! <= 1000 && deadlines[1]! <= deadlines[0]!)
  assert.equal(backend.identity.promptVersion, 'roles-v2')
  assert.equal(closed, true)
})

test('provider exhaustion preserves accepted evidence but never fabricates a result', async () => {
  for (const accepted of [true, false]) {
    let listener: ((event: { id: string, data: { model: string } }) => void) | undefined
    let requests = 0
    const gateway = {
      accepted: undefined as AgentResult | undefined,
      tools: () => [],
      recordUsage: () => true,
      budget: () => ({ submissionCallsRemaining: 1, providerRequestsRemaining: 0 }),
      close: () => {}
    }
    const session = {
      on: (_event: string, callback: typeof listener) => { listener = callback; return () => {} },
      sendAndWait: async () => {
        requests++
        if (accepted) gateway.accepted = exhausted
        listener!({ id: 'last', data: { model: 'test-model' } })
      },
      abort: async () => {}, disconnect: async () => {}
    }
    const client = { createSession: async () => session } as unknown as CopilotClient
    const backend = new CopilotBackend(client, 'test-model', '/tmp/jeeves-test')
    const execution = backend.execute({ role: 'investigator' }, {}, gateway as unknown as Gateway, new AbortController().signal)
    if (accepted) await execution
    else await assert.rejects(execution, /provider_request_budget_exhausted/)
    assert.equal(requests, 1)
    assert.equal(gateway.accepted, accepted ? exhausted : undefined)
  }
})