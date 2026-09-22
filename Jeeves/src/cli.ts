#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { importDataset } from './datasets/import.js'
import { Store } from './storage/store.js'
import { recoverLock } from './storage/lock.js'
import { errorCode } from './security.js'
import { buildIndex } from './analysis/index.js'
import { Navigation } from './analysis/navigation.js'
import { planTasks } from './orchestration/tasks.js'
import { withRunLock } from './storage/lock.js'
import { createClient, stopClient } from './copilot/client.js'
import { CopilotBackend } from './agents/runner.js'
import { runInvestigations } from './orchestration/run.js'
import { report } from './reporting.js'

export async function main (args = process.argv.slice(2)): Promise<void> {
  const command = args[0]
  const { values } = parseArgs({ args: args.slice(1), options: {
    dataset: { type: 'string' }, repo: { type: 'string' }, run: { type: 'string' },
    config: { type: 'string' }, model: { type: 'string' }, workers: { type: 'string' },
    'max-operations': { type: 'string' }, 'semantic-project': { type: 'string' },
    'recover-lock': { type: 'boolean' }, 'allow-live': { type: 'boolean' }
  } })
  if (command === 'doctor') {
    const dotnet = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', timeout: 5000 })
    const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000 })
    console.log(JSON.stringify({ node: process.version, copilotSdk: '1.0.14', sqlite: 'node:sqlite', dotnetAvailable: dotnet.status === 0, sandboxAvailable: docker.status === 0, liveSourceAnalysisRequiresApproval: true }, null, 2))
    return
  }
  if (!values.run) throw new Error('run_path_required')
  const run = path.resolve(values.run)
  if (command === 'import') {
    if (!values.repo || !values.dataset) throw new Error('import_paths_required')
    console.log(JSON.stringify(await importDataset(values.dataset, values.repo, run), null, 2)); return
  }
  if (command === 'resume' && values['recover-lock']) { await recoverLock(run); console.log('lock_recovered'); return }
  if (command === 'index') {
    console.log(JSON.stringify(await buildIndex(run), null, 2))
    if (values['semantic-project']) {
      const store = await Store.open(run); const navigation = new Navigation(store)
      try {
        const call = (await store.query('SELECT file,start FROM calls ORDER BY id LIMIT 1'))[0]
        if (call) console.log(JSON.stringify(await navigation.resolve(String(call.file), Number(call.start), values['semantic-project']), null, 2))
      } finally { navigation.close(); await store.close() }
    }
    return
  }
  if (command === 'plan') {
    await withRunLock(run, async () => {
      const store = await Store.open(run)
      try { console.log(JSON.stringify(await planTasks(store, values['max-operations'] ? Number(values['max-operations']) : 25), null, 2)) } finally { await store.close() }
    })
    return
  }
  if (command === 'status') {
    const store = await Store.open(run)
    try { console.log(JSON.stringify({ manifest: await store.get('manifest'), importComplete: await store.get('importComplete'), tasks: await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state') }, null, 2)) } finally { await store.close() }
    return
  }
  if (command === 'report') { console.log(JSON.stringify(await report(run), null, 2)); return }
  if (command === 'run' || command === 'resume') {
    if (!values['allow-live']) throw new Error('live_source_disclosure_requires_allow_live')
    if (!values.model) throw new Error('explicit_model_required')
    const client = await createClient(run)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
      const models = await client.listModels()
      if (!models.some(model => model.id === values.model)) throw new Error('model_unavailable')
      console.log(JSON.stringify(await runInvestigations(run, new CopilotBackend(client, values.model, run), values.workers ? Number(values.workers) : 2, undefined, controller.signal), null, 2))
      await report(run)
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await stopClient(client) }
    return
  }
  throw new Error('unknown_command')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })
}