#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { importDataset } from './datasets/import.js'
import { Store } from './storage/store.js'
import { recoverLock } from './storage/lock.js'
import { errorCode } from './security.js'

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
  if (command === 'status') {
    const store = await Store.open(run)
    try { console.log(JSON.stringify({ manifest: await store.get('manifest'), importComplete: await store.get('importComplete'), tasks: await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state') }, null, 2)) } finally { await store.close() }
    return
  }
  throw new Error('unknown_command')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })
}