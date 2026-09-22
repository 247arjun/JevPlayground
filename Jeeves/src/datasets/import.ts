import { chmod, mkdir, readdir, realpath, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { classificationSchema, defaultLimits, digestSchema, functionSchema, questionsSchema, validateAnswers } from '../domain.js'
import { atomicJson, canonicalOutput, containedFile, hash, readBounded, relativePath } from '../security.js'
import { Store, putArtifact, type Operation } from '../storage/store.js'
import { withRunLock } from '../storage/lock.js'
import { fileHash, jsonArray, jsonLines } from './stream.js'

const manifestSchema = z.object({
  schemaVersion: z.literal(1), repository: z.string(), revision: z.string(), model: z.string(),
  questionsHash: digestSchema, functionCount: z.number().int().nonnegative(), questionCount: z.number().int().positive(),
  resultFile: z.string(), sourceFile: z.string(), rubricFile: z.string(),
  artifacts: z.record(z.string(), z.object({ sha256: digestSchema, bytes: z.number().int().nonnegative() }))
}).passthrough()
const inventoryFileSchema = z.object({ file: z.string(), sourceHash: digestSchema }).passthrough()
const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.angular', '.cache', 'bin', 'obj'])
const configPattern = /^(?:tsconfig[^/]*\.json|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|host\.json|function\.json|global\.json|appsettings(?:\.[^/]+)?\.json|azuredeploy(?:\.[^/]+)?\.json|Directory\.[^.]+\.(?:props|targets)|[^/]+\.(?:csproj|sln|slnx|bicep|tf))$/i

async function * configurationFiles (root: string, relative = ''): AsyncGenerator<string> {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const file = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory() && !excluded.has(entry.name)) yield * configurationFiles(root, file)
    else if (entry.isFile() && configPattern.test(entry.name)) yield file
  }
}

function purpose (file: string): string {
  if (/(^|\/)(test|tests|__tests__|fixtures|__fixtures__|mocks|__mocks__)(\/|$)|\.(test|spec|stories)\./i.test(file)) return 'test_or_fixture'
  if (/(^|\/)(examples|docker-examples|tools|scripts)(\/|$)/.test(file)) return 'example_or_tooling'
  return 'application_candidate'
}

export async function importDataset (datasetPath: string, sourcePath: string, runPath: string): Promise<Record<string, unknown>> {
  const dataset = await realpath(datasetPath)
  const source = await realpath(sourcePath)
  const run = await canonicalOutput(runPath)
  if ([dataset, source].some(parent => run === parent || run.startsWith(parent + path.sep))) throw new Error('run_must_be_outside_inputs')
  await mkdir(run, { recursive: true, mode: 0o700 })
  return await withRunLock(run, async () => {
    const manifest = manifestSchema.parse(JSON.parse((await readBounded(dataset, 'dataset.json', 1024 * 1024)).toString()))
    for (const relative of [manifest.sourceFile, manifest.resultFile, manifest.rubricFile, 'inventory.json']) {
      relativePath(relative)
      if (!manifest.artifacts[relative]) throw new Error('missing_artifact_descriptor')
    }
    for (const [relative, descriptor] of Object.entries(manifest.artifacts)) {
      if ((await stat(await containedFile(dataset, relative))).size !== descriptor.bytes || await fileHash(dataset, relative) !== descriptor.sha256) throw new Error('dataset_hash_mismatch')
    }
    const questions = questionsSchema.parse(JSON.parse((await readBounded(dataset, manifest.rubricFile, 2 * 1024 * 1024)).toString()))
    if (hash(JSON.stringify(questions)) !== manifest.questionsHash || Object.keys(questions).length !== manifest.questionCount) throw new Error('rubric_mismatch')
    const datasetId = hash(JSON.stringify(manifest))
    const store = await Store.open(run)
    try {
      const previous = await store.get<string>('datasetId')
      if (previous && previous !== datasetId) throw new Error('different_dataset')
      if (await store.get('importComplete')) {
        for await (const file of store.scan('files')) {
          if (await fileHash(source, String(file.path)) !== file.hash) throw new Error('source_hash_mismatch')
        }
        return { status: 'already_imported', ...(await store.get<Record<string, unknown>>('manifest')) }
      }
      await store.set('datasetId', datasetId)
      await store.set('importComplete', false)
      await store.execute('DELETE FROM answers')
      await store.execute('DELETE FROM functions')
      await store.execute('DELETE FROM files')
      const snapshotRoot = path.join(run, 'snapshot/source')
      await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })
      async function capture (file: string, expected?: string): Promise<void> {
        const bytes = await readBounded(source, file, defaultLimits.maxFileBytes)
        const digest = hash(bytes)
        if (expected && digest !== expected) throw new Error('source_hash_mismatch')
        const target = path.join(snapshotRoot, relativePath(file))
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        let exists = true
        try { if (hash(await readBounded(snapshotRoot, file, defaultLimits.maxFileBytes)) !== digest) throw new Error('snapshot_hash_mismatch') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          exists = false
        }
        if (!exists) { await writeFile(target, bytes, { mode: 0o400, flag: 'wx' }); await chmod(target, 0o400) }
        const language = /\.[cm]?[jt]sx?$/i.test(file) ? 'tsjs' : /\.cs$/i.test(file) ? 'csharp' : 'configuration'
        await store.execute('INSERT INTO files VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash,bytes=excluded.bytes', [file, digest, bytes.length, language])
      }
      for await (const raw of jsonArray(dataset, 'inventory.json', 'files')) {
        const file = inventoryFileSchema.parse(raw)
        await capture(file.file, file.sourceHash)
      }
      for await (const file of configurationFiles(source)) await capture(file)
      let functionCount = 0
      let lastFile = ''
      let sourceText = ''
      for await (const raw of jsonLines(dataset, manifest.sourceFile)) {
        const record = functionSchema.parse(raw)
        if (record.file !== lastFile) {
          sourceText = (await readBounded(snapshotRoot, record.file, defaultLimits.maxFileBytes)).toString()
          lastFile = record.file
        }
        if (record.start.offset >= record.end.offset || sourceText.slice(record.start.offset, record.end.offset) !== record.function ||
            hash(record.function) !== record.sourceHash || hash(record.sanitizedFunction) !== record.sanitizedSourceHash ||
            record.function.length !== record.sanitizedFunction.length) throw new Error('function_source_mismatch')
        const artifact = await putArtifact(run, record)
        await store.execute('INSERT INTO functions VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)', [record.id, record.file, record.name, record.kind, record.start.offset, record.end.offset, record.parentId, record.sourceHash, record.sanitizedSourceHash, artifact, purpose(record.file)])
        functionCount++
      }
      let classificationCount = 0
      for await (const raw of jsonArray(dataset, manifest.resultFile)) {
        const record = classificationSchema.parse(raw)
        validateAnswers(record, questions)
        const row = (await store.query('SELECT * FROM functions WHERE id=?', [record.id]))[0]
        if (!row || row.file !== record.file || row.source_hash !== record.sourceHash || row.sanitized_hash !== record.sanitizedSourceHash || record.model !== manifest.model ||
            record.questionsHash && record.questionsHash !== manifest.questionsHash) throw new Error('classification_source_mismatch')
        const artifact = await putArtifact(run, record)
        const operations: Operation[] = [{ sql: 'UPDATE functions SET classification_artifact=? WHERE id=?', params: [artifact, record.id] }]
        for (const [name, answer] of Object.entries(record.answers)) operations.push({ sql: 'INSERT INTO answers VALUES (?,?,?,?,?)', params: [record.id, name, answer.choice, answer.confidence, JSON.stringify(answer.probabilities)] })
        await store.batch(operations)
        classificationCount++
      }
      if (classificationCount !== manifest.functionCount || functionCount < classificationCount) throw new Error('dataset_count_mismatch')
      const fingerprint = createHash('sha256').update(datasetId)
      for await (const file of store.scan('files')) fingerprint.update(JSON.stringify([file.path, file.hash]) + '\n')
      const snapshotId = fingerprint.digest('hex')
      const saved = { schemaVersion: 1, datasetId, snapshotId, repository: manifest.repository, revision: manifest.revision, model: manifest.model, questionsHash: manifest.questionsHash, functionCount, classificationCount, importedAt: new Date().toISOString(), sourceRoot: source }
      await atomicJson(path.join(run, 'inputs/dataset.json'), manifest)
      await atomicJson(path.join(run, 'inputs/questions.snapshot.json'), questions)
      await atomicJson(path.join(run, 'manifest.json'), saved)
      await store.set('manifest', saved)
      await store.set('snapshotId', snapshotId)
      await store.set('importComplete', true)
      return { status: 'imported', ...saved }
    } finally { await store.close() }
  })
}