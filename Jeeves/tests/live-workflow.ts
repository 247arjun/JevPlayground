import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixture } from './fixtures.js'
import { importDataset } from '../src/datasets/import.js'
import { buildIndex } from '../src/analysis/index.js'
import { Store } from '../src/storage/store.js'
import { planTasks } from '../src/orchestration/tasks.js'
import { createClient, stopClient } from '../src/copilot/client.js'
import { CopilotBackend } from '../src/agents/runner.js'
import { runInvestigations } from '../src/orchestration/run.js'
import { report } from '../src/reporting.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-live-workflow-'))
try {
  const paths = await fixture(root)
  await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
  const store = await Store.open(paths.run)
  try { await planTasks(store, 1) } finally { await store.close() }
  const client = await createClient(paths.run)
  try {
    const model = process.env.JEEVES_MODEL ?? 'gpt-5-mini'
    const result = await runInvestigations(paths.run, new CopilotBackend(client, model, paths.run), 1)
    const database = await Store.open(paths.run)
    try {
      const task = (await database.query('SELECT state,error FROM tasks'))[0]
      assert.equal(task?.state, 'completed', `Synthetic task did not complete: ${task?.error}`)
    } finally { await database.close() }
    await report(paths.run)
    console.log(JSON.stringify({ status: 'passed', model, source: 'synthetic-only', result }, null, 2))
  } finally { await stopClient(client) }
} finally { await rm(root, { recursive: true, force: true }) }