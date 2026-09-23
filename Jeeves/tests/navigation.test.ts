import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { syntaxIndex, traceLocalValue } from '../src/analysis/syntax.js'
import { callPage } from '../src/analysis/index.js'
import { Workspaces } from '../src/analysis/workspaces.js'
import { Store } from '../src/storage/store.js'
import { contextEvidence, searchSnapshot } from '../src/analysis/context.js'
import { importDataset } from '../src/datasets/import.js'
import { buildIndex } from '../src/analysis/index.js'
import { fixture } from './fixtures.js'

test('syntax calls preserve nesting and registration is not invocation', () => {
  const result = syntaxIndex('code.ts', 'import { app } from "@azure/functions"; function factory() { return () => fetch("https://example.test") } app.http("example", {handler:factory()});')
  assert.equal(result.calls.length, 3)
  const fetchCall = result.calls.find(call => call.name === 'fetch')!
  assert.ok(fetchCall.callerId)
  assert.equal(fetchCall.data.resolution, 'unresolved')
  assert.equal(result.registrations[0]?.kind, 'azure_functions_registration_candidate')
})

test('local tracing connects identifiers to declarations without treating guards as safety', () => {
  const source = 'function use(input: string) { let value = input; if (input.length) { value = input.trim(); return consume(value) } }'
  const result = traceLocalValue('code.ts', source, source.indexOf('consume(value)') + 8)
  const definitions = result.definitions as Array<{ relationship: string }>
  assert.equal(definitions[0]?.relationship, 'initializer_candidate')
  assert.equal((result.writes as unknown[]).length, 1)
  assert.equal((result.guards as unknown[]).length, 1)
  assert.ok((result.reasons as string[]).includes('aliasing_and_path_feasibility_not_proven'))
  const parameter = traceLocalValue('code.ts', source, source.indexOf('= input') + 2)
  assert.equal((parameter.definitions as Array<{ relationship: string }>)[0]?.relationship, 'parameter_boundary')
})

test('call lookup uses bounded stable pages and rejects mismatched generations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-page-')); const store = await Store.open(root)
  try {
    await store.set('indexGeneration', 'first')
    await store.batch(Array.from({ length: 300 }, (_, index) => ({ sql: 'INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)', params: [String(index).padStart(4, '0'), 'code.ts', index, index + 1, null, 'target', 'target', '{}'] })))
    const ids = new Set<string>(); let cursor: string | undefined
    do {
      const page = await callPage(store, 'target', cursor, 37)
      const rows = page.rows as Array<{ id: string }>
      assert.ok(rows.length <= 37)
      for (const row of rows) { assert.ok(!ids.has(row.id)); ids.add(row.id) }
      cursor = page.cursor as string | undefined
    } while (cursor)
    assert.equal(ids.size, 300)
    const first = await callPage(store, 'target', undefined, 1)
    await store.set('indexGeneration', 'second')
    await assert.rejects(callPage(store, 'target', String(first.cursor)), /stale_or_foreign_cursor/)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('shared semantic worker resolves imported aliases with one cold load', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-project-'))
  const pool = new Workspaces(root)
  try {
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['*.ts'] }))
    await writeFile(path.join(root, 'helper.ts'), 'export function target(value: string) { return value }')
    const source = 'import {target as alias} from "./helper.js"; export function caller() { return alias("value") }'
    await writeFile(path.join(root, 'code.ts'), source)
    const site = syntaxIndex('code.ts', source).calls[0]!
    const results = await Promise.all(Array.from({ length: 5 }, () => pool.resolve('tsconfig.json', 'code.ts', site.start)))
    assert.deepEqual(results[0], results[1])
    const result = results[0] as { targets: Array<{ file: string, implementation: boolean }> }
    assert.ok(result.targets.some(target => target.file === 'helper.ts' && target.implementation))
    assert.equal(pool.metrics.loads, 1)
    assert.equal(pool.metrics.coalesced, 4)
    assert.equal(pool.metrics.maxResident, 1)
    const expectedTarget = (results[0] as { targets: Array<{ id: string }> }).targets[0]!.id
    const callers = await pool.callers('tsconfig.json', expectedTarget, undefined, 1) as { rows: Array<{ file: string }>, reasons: string[] }
    assert.equal(callers.rows[0]?.file, 'code.ts')
    assert.ok(callers.reasons.includes('unsearched_projects_and_external_consumers'))
    assert.equal(pool.metrics.loads, 1)
  } finally { pool.close(); await rm(root, { recursive: true, force: true }) }
})

test('context parsers preserve offsets and distinguish HTML bindings from escaped text', () => {
  const html = '<!-- private hint --><p>{{ value }}</p><div [innerHTML]="value"></div>'
  const evidence = contextEvidence('view.html', html, 'template')
  assert.equal(evidence.sanitized.length, html.length)
  assert.ok(!evidence.sanitized.includes('private hint'))
  assert.equal(evidence.anchors.filter(anchor => anchor.data.htmlBinding).length, 1)
  const yaml = 'limits:\n  attempts: 3 # hint\n'
  const configuration = contextEvidence('config.yml', yaml, 'configuration')
  assert.equal(configuration.sanitized.length, yaml.length)
  assert.ok(!configuration.sanitized.includes('hint'))
  assert.ok(configuration.anchors.length > 0)
  const routing = contextEvidence('server.ts', 'import { handler } from "./route"; app.get("/resource", wrap(handler()));', 'tsjs')
  assert.equal(routing.relationships.find(relation => relation.kind === 'route_handler')?.target, './route')
  assert.ok(contextEvidence('invalid.ts', 'export function broken(', 'tsjs').reasons.includes('typescript_parse_error'))
  assert.ok(contextEvidence('invalid.json', '{"value":', 'configuration').reasons.includes('json_parse_error'))
})

test('indexed search reaches late files and relationships connect source to templates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-context-index-'))
  try {
    const paths = await fixture(root)
    await writeFile(path.join(paths.source, 'component.ts'), 'const component = { templateUrl: "./view.html" }; export const needle = 1')
    await writeFile(path.join(paths.source, 'view.html'), '<p>{{ needle }}</p>')
    await writeFile(path.join(paths.source, 'z.ts'), 'export const needle = 2; const another = "needle"')
    await mkdir(path.join(paths.source, 'fixtures'))
    await writeFile(path.join(paths.source, 'fixtures/handler.ts'), 'export const handler = () => true')
    await writeFile(path.join(paths.source, 'server.ts'), 'import { handler } from "./fixtures/handler"; app.get("/resource", wrap(handler));')
    await importDataset(paths.dataset, paths.source, paths.run); await buildIndex(paths.run)
    const store = await Store.open(paths.run)
    try {
      const matches: unknown[] = []; let cursor: string | undefined
      do {
        const page = await searchSnapshot(store, 'needle', '', cursor, 1)
        matches.push(...page.matches as unknown[]); cursor = page.cursor as string | undefined
      } while (cursor)
      assert.equal(matches.length, 4)
      const scoped = await searchSnapshot(store, 'needle', 'z.ts')
      assert.equal((scoped.matches as unknown[]).length, 2)
      assert.equal((await store.query('SELECT target FROM relationships WHERE kind=?', ['component_template']))[0]?.target, 'view.html')
      const purpose = (await store.query('SELECT purpose,data FROM file_context WHERE file=?', ['fixtures/handler.ts']))[0]!
      assert.equal(purpose.purpose, 'application_candidate')
      assert.equal(JSON.parse(String(purpose.data)).originalPathPurpose, 'test_or_fixture')
      assert.ok((await store.query('SELECT id FROM review_subjects WHERE kind=?', ['template'])).length)
      const first = await searchSnapshot(store, 'needle', '', undefined, 1)
      await store.set('indexGeneration', 'changed')
      await assert.rejects(searchSnapshot(store, 'needle', '', String(first.cursor)), /stale_or_foreign_cursor/)
    } finally { await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})