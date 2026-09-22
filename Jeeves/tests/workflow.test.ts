import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fixture } from './import.test.js'
import { importDataset } from '../src/datasets/import.js'
import { buildIndex } from '../src/analysis/index.js'
import { Navigation } from '../src/analysis/navigation.js'
import { planTasks } from '../src/orchestration/tasks.js'
import { runInvestigations } from '../src/orchestration/run.js'
import { Store } from '../src/storage/store.js'
import { Gateway } from '../src/tools/gateway.js'
import { report } from '../src/reporting.js'
import type { AgentResult } from '../src/domain.js'

test('role workflow persists verified evidence and reports without live models', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-workflow-'))
  try {
    const paths = await fixture(root); await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try { await planTasks(store, 1) } finally { await store.close() }
    const roles: string[] = []
    await runInvestigations(paths.run, { execute: async (task, _context, gateway) => {
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