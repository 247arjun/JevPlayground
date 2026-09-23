import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fixture } from './fixtures.js'
import { importDataset } from '../src/datasets/import.js'
import { buildIndex } from '../src/analysis/index.js'
import { planTasks } from '../src/orchestration/tasks.js'
import { Store } from '../src/storage/store.js'
import { evaluateReviewBenchmark } from '../src/review-benchmark.js'
import { main } from '../src/cli.js'

test('coverage benchmarks separate selection from detection and reject changed revisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-review-benchmark-'))
  try {
    const paths = await fixture(root)
    await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try { await planTasks(store) } finally { await store.close() }
    const specification = { schemaVersion: 1, repository: 'fixture', revision: 'fixture', description: 'Offline selection test, not a vulnerability claim.', cases: [{ id: 'scope', rootCause: 'Review the selected function.', expected: 'positive', file: 'code.ts', line: 1, themes: ['general-review'], caveat: 'Synthetic selection fixture.' }] }
    const file = path.join(root, 'benchmark.json')
    await writeFile(file, JSON.stringify(specification))
    const result = await evaluateReviewBenchmark(paths.run, file)
    assert.equal(result.selectionRecall, 1)
    assert.equal(result.detectionRecall, null)
    assert.equal((result.cases as Array<{ status: string }>)[0]?.status, 'pending')
    await writeFile(file, JSON.stringify({ ...specification, revision: 'different' }))
    await assert.rejects(evaluateReviewBenchmark(paths.run, file), /benchmark_revision_mismatch/)
    await assert.rejects(main(['run', '--run', paths.run, '--model', 'not-used', '--allow-live']), /explicit_overall_budget_required/)
    await assert.rejects(main(['approve-followups', '--run', paths.run]), /explicit_followup_approval_required/)
  } finally { await rm(root, { recursive: true, force: true }) }
})