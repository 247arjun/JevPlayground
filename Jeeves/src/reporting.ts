import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicJson } from './security.js'
import { Store, getArtifact } from './storage/store.js'

function escape (value: unknown): string { return String(value).replace(/[&<>|\[\]`\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]/g, ' ') }

export async function report (run: string): Promise<Record<string, unknown>> {
  const store = await Store.open(run)
  const directory = path.join(run, 'reports'); await mkdir(directory, { recursive: true, mode: 0o700 })
  const jsonFile = path.join(directory, 'investigations.json')
  const markdownFile = path.join(directory, 'summary.md')
  const json = await open(jsonFile + '.tmp', 'w', 0o600); const markdown = await open(markdownFile + '.tmp', 'w', 0o600)
  try {
    await json.write('[\n')
    await markdown.write('# Jeeves Investigation Report\n\nModel hypotheses, not verified vulnerabilities. No production resources were tested.\n\n| Task | Theme | State | Disposition | Summary |\n| --- | --- | --- | --- | --- |\n')
    let count = 0
    for await (const task of store.scan('tasks')) {
      const result = task.result ? await getArtifact<Record<string, unknown>>(run, String(task.result)) : null
      const record = { ...task, result }
      await json.write((count ? ',\n' : '') + JSON.stringify(record))
      await markdown.write(`| ${escape(String(task.id).slice(0, 12))} | ${escape(task.theme)} | ${escape(task.state)} | ${escape(result?.disposition ?? 'unexamined')} | ${escape(result?.summary ?? task.error ?? 'No accepted result')} |\n`)
      count++
    }
    await json.write('\n]\n'); await json.sync(); await markdown.sync()
    const coverage = { manifest: await store.get('manifest'), index: await store.get('indexStats'), capabilities: await store.query('SELECT capability,reasons,COUNT(*) AS count FROM coverage GROUP BY capability,reasons'), tasks: await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state'), modelCalls: await store.get('modelCalls') ?? 0, caveats: ['Only planned operations investigated', 'Callers are candidates; dynamic dispatch remains unresolved', 'No automatic vulnerability or safety certification', 'Memory RSS limit is soft; compiler heap and deadlines are enforced'] }
    await atomicJson(path.join(directory, 'coverage.json'), coverage)
    return { investigations: count, ...coverage }
  } finally {
    await json.close(); await markdown.close(); await store.close()
    await rename(jsonFile + '.tmp', jsonFile); await rename(markdownFile + '.tmp', markdownFile)
  }
}