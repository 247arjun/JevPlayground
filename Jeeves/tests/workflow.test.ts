import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fixture } from './fixtures.js'
import { importDataset } from '../src/datasets/import.js'
import { buildIndex } from '../src/analysis/index.js'
import { Navigation } from '../src/analysis/navigation.js'
import { planTasks } from '../src/orchestration/tasks.js'
import { runInvestigations } from '../src/orchestration/run.js'
import { Store } from '../src/storage/store.js'
import { Gateway } from '../src/tools/gateway.js'
import { report } from '../src/reporting.js'
import { defaultLimits, type AgentResult } from '../src/domain.js'

async function invokeTool (gateway: Gateway, name: string, input: unknown): Promise<Record<string, unknown>> {
  const tool = gateway.tools().find(tool => tool.name === name)
  assert.ok(tool?.handler)
  const invocation = { sessionId: 'test', toolCallId: name, toolName: name, arguments: input }
  return await tool.handler(input, invocation) as Record<string, unknown>
}

test('role workflow persists verified evidence and reports without live models', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-workflow-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try {
      const generation = await store.get('indexGeneration')
      await store.set('indexGeneration', null)
      await store.set('indexBuilding', generation)
    } finally { await store.close() }
    const recovered = await buildIndex(paths.run)
    assert.equal(recovered.status, 'indexed')
    assert.ok(Number(recovered.reusedFiles) >= 2)
    const planningStore = await Store.open(paths.run)
    try {
      const stats = await planningStore.get<Record<string, unknown>>('indexStats')
      await planningStore.set('indexStats', { ...stats, incompleteFiles: 1 })
    } finally { await planningStore.close() }
    const retried = await buildIndex(paths.run)
    assert.equal(retried.status, 'indexed')
    const readyStore = await Store.open(paths.run)
    try { await planTasks(readyStore, 1) } finally { await readyStore.close() }
    const roles: string[] = []
    await runInvestigations(paths.run, { execute: async (task, context, gateway) => {
      assert.deepEqual(Object.keys((context as { classification: Record<string, unknown> }).classification), ['model', 'answers'])
      roles.push(String(task.role))
      const source = await readFile(path.join(paths.source, 'code.ts'), 'utf8')
      const evidence = await gateway.read('code.ts', 0, source.length)
      const citation = { file: 'code.ts', start: 0, end: source.length, sourceHash: String(evidence.sourceHash) }
      await gateway.accept({ disposition: task.role === 'challenger' ? 'refuted_hypothesis' : 'needs_context', summary: 'This returns the argument without a data store operation.', operation: citation, invariant: 'No external operation established', facts: [{ text: 'Returns supplied value.', citations: [citation] }], assumptions: [], counterevidence: [], unresolved: [] })
    } })
    assert.deepEqual(roles, ['localizer', 'investigator', 'challenger'])
    await report(paths.run)
    const results = JSON.parse(await readFile(path.join(paths.run, 'reports/investigations.json'), 'utf8'))
    assert.equal(results[0].result.disposition, 'refuted_hypothesis')
    assert.equal(results[0].state, 'completed')
    const coverage = JSON.parse(await readFile(path.join(paths.run, 'reports/coverage.json'), 'utf8'))
    assert.equal(coverage.execution.queueDrained, true)
    assert.ok(coverage.catalogue.some((row: { decision: string }) => row.decision === 'deferred'))
    assert.ok((await readFile(path.join(paths.run, 'reports/candidates.jsonl'), 'utf8')).includes('classification_signals'))
    await runInvestigations(paths.run, { execute: async () => { assert.fail('Completed tasks must not rerun') } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('result citations must be observed, in range and inside the selected function', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-citation-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run)
    const store = await Store.open(paths.run); const navigation = new Navigation(store)
    try {
      const fn = (await store.query('SELECT * FROM functions'))[0]!
      const gateway = new Gateway(store, navigation, { id: 'test', role: 'localizer', function_id: String(fn.id) })
      const result: AgentResult = { disposition: 'supported_candidate', summary: 'Claim', invariant: 'Claim', operation: { file: 'code.ts', start: 0, end: 5, sourceHash: '0'.repeat(64) }, facts: [], assumptions: [], counterevidence: [], unresolved: [] }
      await assert.rejects(gateway.accept(result), /citation_not_observed/)
      await gateway.read('code.ts', 0, Number(fn.end))
      await assert.rejects(gateway.accept(result), /citation_not_observed/)
      gateway.close()
      await assert.rejects(gateway.read('code.ts', 0, 1), /attempt_closed/)
    } finally { navigation.close(); await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('retrieval exhaustion reserves the final tool call for a validated result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-finalize-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run)
    const store = await Store.open(paths.run); const navigation = new Navigation(store)
    try {
      const fn = (await store.query('SELECT * FROM functions'))[0]!
      const gateway = new Gateway(store, navigation, { id: 'test', role: 'localizer', function_id: String(fn.id) }, { ...defaultLimits, maxToolCalls: 2 })
      const evidence = await invokeTool(gateway, 'read_source', { file: 'code.ts', start: 0, end: Number(fn.end) })
      const citation = { file: 'code.ts', start: 0, end: Number(fn.end), sourceHash: String(evidence.sourceHash) }
      assert.equal((evidence.budget as Record<string, unknown>).nextAction, 'submit_result')
      assert.equal((await invokeTool(gateway, 'read_source', { file: 'code.ts', start: 0, end: 1 })).error, 'retrieval_budget_exhausted')
      const result: AgentResult = { disposition: 'needs_context', summary: 'Caller context remains unresolved.', invariant: 'Establish the caller boundary.', operation: citation, facts: [{ text: 'The function returns its argument.', citations: [citation] }], assumptions: [], counterevidence: [], unresolved: ['Caller context was not retrieved within budget.'] }
      assert.equal((await invokeTool(gateway, 'submit_result', result)).accepted, true)
      assert.deepEqual(gateway.accepted, result)
      assert.equal(gateway.usage().toolCalls, 2)
      assert.equal(gateway.usage().rejectedToolCalls, 1)
      assert.deepEqual(gateway.usage().toolErrors, { retrieval_budget_exhausted: 1 })
    } finally { navigation.close(); await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('read_source returns actual EOF spans and cancellation prevents late acceptance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-source-window-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run)
    const store = await Store.open(paths.run); const navigation = new Navigation(store)
    try {
      const fn = (await store.query('SELECT * FROM functions'))[0]!
      const gateway = new Gateway(store, navigation, { id: 'test', role: 'localizer', function_id: String(fn.id) })
      const evidence = await invokeTool(gateway, 'read_source', { file: 'code.ts', start: 0, end: Number(fn.end) + 1000 })
      assert.equal(evidence.end, Number(fn.end))
      assert.equal(evidence.fileLength, Number(fn.end))
      const invalid = await invokeTool(gateway, 'read_source', { file: 'code.ts', start: Number(fn.end), end: Number(fn.end) + 1 })
      assert.equal(invalid.error, 'invalid_source_span')
      assert.equal(invalid.fileLength, Number(fn.end))
      const citation = { file: 'code.ts', start: 0, end: Number(fn.end), sourceHash: String(evidence.sourceHash) }
      const pending = gateway.accept({ disposition: 'needs_context', summary: 'Unresolved caller.', invariant: 'Check callers.', operation: citation, facts: [{ text: 'Returns an argument.', citations: [citation] }], assumptions: [], counterevidence: [], unresolved: [] })
      gateway.close()
      await assert.rejects(pending, /result_already_submitted/)
      assert.equal(gateway.accepted, undefined)
    } finally { navigation.close(); await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('provider reserve stops retrieval but does not bypass result validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-provider-reserve-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run)
    const store = await Store.open(paths.run); const navigation = new Navigation(store)
    try {
      const fn = (await store.query('SELECT * FROM functions'))[0]!
      const gateway = new Gateway(store, navigation, { id: 'test', role: 'localizer', function_id: String(fn.id) }, { ...defaultLimits, maxProviderRequests: 3 })
      gateway.recordUsage({ id: 'first', model: 'test' })
      assert.equal((await invokeTool(gateway, 'read_source', { file: 'code.ts', start: 0, end: 1 })).error, 'finalization_required')
      const citation = { file: 'code.ts', start: 0, end: Number(fn.end), sourceHash: '0'.repeat(64) }
      const invalid = { disposition: 'supported_candidate', summary: 'Unobserved claim.', invariant: 'Claim', operation: citation, facts: [{ text: 'Not read.', citations: [citation] }], assumptions: [], counterevidence: [], unresolved: [] }
      assert.equal((await invokeTool(gateway, 'submit_result', invalid)).error, 'citation_not_observed')
      assert.equal(gateway.accepted, undefined)
      assert.equal((await invokeTool(gateway, 'submit_result', {})).error, 'invalid_result_schema')
      const result: AgentResult = { disposition: 'budget_exhausted', summary: 'Insufficient evidence within budget.', invariant: '', operation: null, facts: [], assumptions: [], counterevidence: [], unresolved: ['No source was retrieved.'] }
      assert.equal((await invokeTool(gateway, 'submit_result', result)).accepted, true)
      assert.deepEqual(gateway.accepted, result)
    } finally { navigation.close(); await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('source withheld by the byte limit is not valid citation evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-withheld-source-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run)
    const store = await Store.open(paths.run); const navigation = new Navigation(store)
    try {
      const fn = (await store.query('SELECT * FROM functions'))[0]!
      const gateway = new Gateway(store, navigation, { id: 'test', role: 'localizer', function_id: String(fn.id) }, { ...defaultLimits, maxResultBytes: 1024 })
      const read = gateway.read.bind(gateway)
      gateway.read = async (...args) => ({ ...await read(...args), padding: 'x'.repeat(1024) })
      const evidence = await invokeTool(gateway, 'read_source', { file: 'code.ts', start: 0, end: Number(fn.end) })
      assert.equal(evidence.error, 'context_byte_budget_exhausted')
      const citation = { file: 'code.ts', start: 0, end: Number(fn.end), sourceHash: String(fn.source_hash) }
      await assert.rejects(gateway.accept({ disposition: 'needs_context', summary: 'Unobserved claim.', invariant: 'Claim', operation: citation, facts: [{ text: 'Not delivered.', citations: [citation] }], assumptions: [], counterevidence: [], unresolved: [] }), /citation_not_observed/)
      const result: AgentResult = { disposition: 'budget_exhausted', summary: 'The source did not fit.', invariant: '', operation: null, facts: [], assumptions: [], counterevidence: [], unresolved: ['Source not observed within budget.'] }
      assert.equal((await invokeTool(gateway, 'submit_result', result)).accepted, true)
    } finally { navigation.close(); await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('non-function subjects use parsed citation anchors and remain unclassified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-template-review-'))
  try {
    const paths = await fixture(root)
    const text = '<p>{{ message }}</p>'
    await writeFile(path.join(paths.source, 'view.html'), text)
    await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try { await planTasks(store) } finally { await store.close() }
    let sawTemplate = false
    await runInvestigations(paths.run, { execute: async (task, context, gateway) => {
      const input = context as { subject: { file: string, start: number, end: number }, classification: unknown, function: unknown }
      if (input.subject.file === 'view.html') {
        sawTemplate = true; assert.equal(input.classification, null); assert.equal(input.function, null)
        const evidence = await gateway.read('view.html', 0, text.length)
        const citation = { file: 'view.html', start: 0, end: text.length, sourceHash: String(evidence.sourceHash) }
        await assert.rejects(gateway.accept({ disposition: 'needs_context', summary: 'Invalid fragment.', operation: { ...citation, end: 3 }, invariant: '', facts: [], assumptions: [], counterevidence: [], unresolved: [] }), /operation_not_parsed_anchor/)
        await gateway.accept({ disposition: 'refuted_hypothesis', summary: 'The selected template displays a text interpolation.', operation: citation, invariant: 'Treat user text as text.', facts: [{ text: 'Plain interpolation is shown.', citations: [citation] }], assumptions: [], counterevidence: [], unresolved: [] })
      } else await gateway.accept({ disposition: 'no_relevant_operation', summary: 'No operation selected by the offline fixture.', operation: null, invariant: '', facts: [], assumptions: [], counterevidence: [], unresolved: [] })
    } })
    assert.equal(sawTemplate, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('overall session and provider budgets pause queued work across resumes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-run-budget-'))
  try {
    const paths = await fixture(root)
    await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try { await planTasks(store) } finally { await store.close() }
    let calls = 0
    const backend = { execute: async (_task: unknown, _context: unknown, gateway: Gateway) => {
      calls++
      await gateway.accept({ disposition: 'no_relevant_operation', summary: 'Offline fixture result.', operation: null, invariant: '', facts: [], assumptions: [], counterevidence: [], unresolved: [] })
    } }
    const outcome = await runInvestigations(paths.run, backend, 1, { ...defaultLimits, maxModelCalls: 1 })
    assert.equal(outcome.blockReason, 'run_session_budget_exhausted')
    await runInvestigations(paths.run, backend, 1, { ...defaultLimits, maxModelCalls: 1 })
    assert.equal(calls, 1)
    const paused = await runInvestigations(paths.run, { execute: async (_task, _context, gateway, signal) => {
      gateway.recordUsage({ id: 'event-one', model: 'fake', inputTokens: 1, outputTokens: 1 })
      assert.equal(signal.aborted, true)
      throw new Error('cancelled')
    } }, 1, { ...defaultLimits, maxRunProviderRequests: 1 })
    assert.equal(paused.blockReason, 'run_provider_budget_exhausted')
    const saved = await Store.open(paths.run)
    try {
      assert.equal((await saved.query('SELECT COUNT(*) AS count FROM provider_usage'))[0]?.count, 1)
      assert.ok((await saved.query("SELECT id FROM tasks WHERE state='queued'")).length)
      assert.equal((await saved.query("SELECT id FROM tasks WHERE state='failed'")).length, 0)
    } finally { await saved.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('crash recovery charges only time since the last atomic clock checkpoint', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-clock-'))
  try {
    const paths = await fixture(root)
    await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try {
      await planTasks(store)
      await store.set('runElapsedMs', 5000)
      await store.set('activeSegmentStarted', 9000)
    } finally { await store.close() }
    await runInvestigations(paths.run, { execute: async () => { assert.fail('Exhausted time must not start a model call') } }, 1, { ...defaultLimits, maxRunDurationMs: 6000 })
    const recovered = await Store.open(paths.run)
    try {
      assert.equal(await recovered.get('runElapsedMs'), 6000)
      assert.equal(await recovered.get('activeSegmentStarted'), null)
      assert.equal(await recovered.get('blockReason'), 'run_time_budget_exhausted')
      assert.equal((await recovered.query('SELECT COUNT(*) AS count FROM attempts'))[0]?.count, 0)
    } finally { await recovered.close() }
    await runInvestigations(paths.run, { execute: async () => { assert.fail('Resuming must not reset time') } }, 1, { ...defaultLimits, maxRunDurationMs: 6000 })
    const repeated = await Store.open(paths.run)
    try { assert.equal(await repeated.get('runElapsedMs'), 6000) } finally { await repeated.close() }
  } finally { context.mock.timers.reset(); await rm(root, { recursive: true, force: true }) }
})