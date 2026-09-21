import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importDataset } from '../src/datasets/import.js'
import { hash } from '../src/security.js'
import { Store } from '../src/storage/store.js'

export async function fixture (root: string): Promise<{ source: string, dataset: string, run: string }> {
  const source = path.join(root, 'source'); const dataset = path.join(root, 'dataset'); const run = path.join(root, 'run')
  await mkdir(source); await mkdir(dataset)
  const text = 'export function lookup(value: string) { return value }'
  const questions = { operation_data_store_access: { type: 'choice', instructions: 'Read state.function', criteria: { present: 'present', absent: 'absent', unclear: 'unclear' } } }
  const questionsHash = hash(JSON.stringify(questions))
  const record = { id: `code.ts:0-${text.length}`, file: 'code.ts', name: 'lookup', kind: 'FunctionDeclaration', parentId: null, start: { offset: 0, line: 1, column: 1 }, end: { offset: text.length, line: 1, column: text.length + 1 }, sourceHash: hash(text), sanitizedSourceHash: hash(text), sanitizerVersion: 'test', function: text, sanitizedFunction: text, parseDiagnostics: [] }
  await writeFile(path.join(source, 'code.ts'), text)
  await writeFile(path.join(source, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
  const contents: Record<string, string> = {
    'questions.snapshot.json': JSON.stringify(questions),
    'inventory.json': JSON.stringify({ files: [{ file: 'code.ts', sourceHash: hash(text) }], skipped: [] }),
    'functions.jsonl': JSON.stringify(record) + '\n',
    'classifications.json': JSON.stringify([{ ...record, model: 'test-model', questionsHash, answers: { operation_data_store_access: { type: 'choice', choice: 'present', confidence: 1, probabilities: { present: 1, absent: 0, unclear: 0 } } } }])
  }
  for (const [name, content] of Object.entries(contents)) await writeFile(path.join(dataset, name), content)
  await writeFile(path.join(dataset, 'dataset.json'), JSON.stringify({ schemaVersion: 1, repository: 'fixture', revision: 'fixture', model: 'test-model', questionsHash, functionCount: 1, questionCount: 1, resultFile: 'classifications.json', sourceFile: 'functions.jsonl', rubricFile: 'questions.snapshot.json', artifacts: Object.fromEntries(Object.entries(contents).map(([name, content]) => [name, { sha256: hash(content), bytes: Buffer.byteLength(content) }])) }))
  return { source, dataset, run }
}

test('streams and verifies a dataset, snapshots config, and detects stale source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-import-'))
  try {
    const paths = await fixture(root)
    const result = await importDataset(paths.dataset, paths.source, paths.run)
    assert.equal(result.classificationCount, 1)
    assert.equal((await importDataset(paths.dataset, paths.source, paths.run)).status, 'already_imported')
    const store = await Store.open(paths.run)
    try {
      assert.equal((await store.query('SELECT COUNT(*) AS total FROM answers'))[0]?.total, 1)
      await store.set('importComplete', false)
    } finally { await store.close() }
    assert.equal((await importDataset(paths.dataset, paths.source, paths.run)).status, 'imported')
    assert.ok((await readFile(path.join(paths.run, 'snapshot/source/tsconfig.json'), 'utf8')).includes('strict'))
    await writeFile(path.join(paths.source, 'code.ts'), 'changed')
    await assert.rejects(importDataset(paths.dataset, paths.source, paths.run), /source_hash_mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})