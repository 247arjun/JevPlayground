import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const database = new DatabaseSync(workerData.file as string)
database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=3000;
  PRAGMA cache_size=-8192;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL, language TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS functions (
    id TEXT PRIMARY KEY, file TEXT NOT NULL REFERENCES files(path), name TEXT NOT NULL, kind TEXT NOT NULL,
    start INTEGER NOT NULL, end INTEGER NOT NULL, parent_id TEXT, source_hash TEXT NOT NULL,
    sanitized_hash TEXT NOT NULL, artifact TEXT NOT NULL, classification_artifact TEXT, purpose TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS functions_location ON functions(file,start,end);
  CREATE TABLE IF NOT EXISTS answers (function_id TEXT NOT NULL REFERENCES functions(id), question TEXT NOT NULL,
    choice TEXT NOT NULL, confidence REAL NOT NULL, probabilities TEXT NOT NULL, PRIMARY KEY(function_id,question));
  CREATE INDEX IF NOT EXISTS answers_choice ON answers(question,choice,function_id);
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, file TEXT NOT NULL, language TEXT NOT NULL, fingerprint TEXT NOT NULL, capability TEXT NOT NULL, diagnostics TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, file TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
    caller_id TEXT, name TEXT NOT NULL, expression TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS calls_name ON calls(name,id);
  CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller_id,id);
  CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY, file TEXT NOT NULL, start INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS semantic_results (key TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS coverage (scope TEXT PRIMARY KEY, capability TEXT NOT NULL, reasons TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, function_id TEXT NOT NULL REFERENCES functions(id), theme TEXT NOT NULL,
    purpose TEXT NOT NULL, state TEXT NOT NULL, role TEXT NOT NULL, attempt TEXT, deadline INTEGER, result TEXT, error TEXT, priority INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(state,priority,id);
  CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
    started INTEGER NOT NULL, finished INTEGER, state TEXT NOT NULL, request_artifact TEXT, result_artifact TEXT);
  CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, time INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS evidence (hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, artifact TEXT NOT NULL);
  PRAGMA user_version=1;
`)

type Operation = { sql: string, params?: SQLInputValue[], mode?: 'all' | 'get' | 'run' }
function execute (operation: Operation): unknown {
  const statement = database.prepare(operation.sql)
  if (operation.mode === 'all') return statement.all(...(operation.params ?? []))
  if (operation.mode === 'get') return statement.get(...(operation.params ?? [])) ?? null
  const result = statement.run(...(operation.params ?? []))
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
}

parentPort!.on('message', (message: { id: number, kind: string, operations: Operation[] }) => {
  try {
    if (message.kind === 'close') {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      database.close()
      parentPort!.postMessage({ id: message.id, value: null })
      parentPort!.close()
      return
    }
    const transaction = message.kind === 'batch'
    if (transaction) database.exec('BEGIN IMMEDIATE')
    try {
      const value = message.operations.map(execute)
      if (transaction) database.exec('COMMIT')
      parentPort!.postMessage({ id: message.id, value })
    } catch (error) {
      if (transaction) database.exec('ROLLBACK')
      throw error
    }
  } catch {
    parentPort!.postMessage({ id: message.id, error: 'database_operation_failed' })
  }
})
parentPort!.postMessage({ ready: true })