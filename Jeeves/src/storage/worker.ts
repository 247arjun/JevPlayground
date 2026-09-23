import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const database = new DatabaseSync(workerData.file as string, { readOnly: Boolean(workerData.readOnly) })
const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
if (version.user_version > 2) throw new Error('unsupported_database_version')
if (!workerData.readOnly) {
database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=3000;
  PRAGMA cache_size=-8192;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL, language TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS file_context (file TEXT PRIMARY KEY REFERENCES files(path), purpose TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshot_omissions (path TEXT PRIMARY KEY, reason TEXT NOT NULL, bytes INTEGER);
  CREATE TABLE IF NOT EXISTS public_assets (path TEXT PRIMARY KEY, bytes INTEGER NOT NULL, extension TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS context_files (file TEXT PRIMARY KEY REFERENCES files(path), hash TEXT NOT NULL, capability TEXT NOT NULL, reasons TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS context_text (file TEXT PRIMARY KEY REFERENCES files(path), artifact TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS source_anchors (file TEXT NOT NULL REFERENCES files(path), start INTEGER NOT NULL, end INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(file,start,end,kind));
  CREATE TABLE IF NOT EXISTS relationships (id TEXT PRIMARY KEY, file TEXT NOT NULL REFERENCES files(path), start INTEGER NOT NULL, end INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS relationships_file ON relationships(file,id);
  CREATE INDEX IF NOT EXISTS relationships_target ON relationships(target,id);
  CREATE VIRTUAL TABLE IF NOT EXISTS source_search USING fts5(file UNINDEXED, start UNINDEXED, text, tokenize='trigram');
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
  CREATE TABLE IF NOT EXISTS index_batches (generation TEXT NOT NULL, file TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(generation,file));
  CREATE TABLE IF NOT EXISTS review_subjects (id TEXT PRIMARY KEY, function_id TEXT UNIQUE REFERENCES functions(id),
    file TEXT NOT NULL REFERENCES files(path), start INTEGER NOT NULL, end INTEGER NOT NULL, kind TEXT NOT NULL,
    purpose TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
  CREATE INDEX IF NOT EXISTS subjects_location ON review_subjects(file,start,end);
  CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES review_subjects(id),
    theme TEXT NOT NULL, purpose TEXT NOT NULL, priority INTEGER NOT NULL, rank TEXT NOT NULL,
    decision TEXT NOT NULL, reason TEXT NOT NULL, duplicate_of TEXT, UNIQUE(subject_id,theme));
  CREATE INDEX IF NOT EXISTS candidates_selection ON candidates(decision,priority,rank,id);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, function_id TEXT REFERENCES functions(id), theme TEXT NOT NULL,
    purpose TEXT NOT NULL, state TEXT NOT NULL, role TEXT NOT NULL, attempt TEXT, deadline INTEGER, result TEXT, error TEXT, priority INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(state,priority,id);
  CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
    started INTEGER NOT NULL, finished INTEGER, state TEXT NOT NULL, request_artifact TEXT, result_artifact TEXT);
  CREATE TABLE IF NOT EXISTS provider_usage (id TEXT PRIMARY KEY, attempt TEXT NOT NULL REFERENCES attempts(id), model TEXT NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER, cost_multiplier REAL, time INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, time INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS evidence (hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, artifact TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_results (task_id TEXT PRIMARY KEY REFERENCES tasks(id), disposition TEXT NOT NULL, operation_key TEXT, artifact TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS results_operation ON task_results(operation_key,task_id);
  CREATE TABLE IF NOT EXISTS followups (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), subject_id TEXT NOT NULL REFERENCES review_subjects(id),
    theme TEXT NOT NULL, operation TEXT NOT NULL, rationale TEXT NOT NULL, depth INTEGER NOT NULL, state TEXT NOT NULL, candidate_id TEXT);
`)

if (version.user_version === 1) database.exec(`
  PRAGMA foreign_keys=OFF;
  BEGIN IMMEDIATE;
  CREATE TABLE tasks_v2 (id TEXT PRIMARY KEY, function_id TEXT REFERENCES functions(id), theme TEXT NOT NULL,
    purpose TEXT NOT NULL, state TEXT NOT NULL, role TEXT NOT NULL, attempt TEXT, deadline INTEGER, result TEXT, error TEXT, priority INTEGER NOT NULL);
  INSERT INTO tasks_v2 SELECT * FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v2 RENAME TO tasks;
  CREATE INDEX tasks_queue ON tasks(state,priority,id);
  COMMIT;
  PRAGMA foreign_keys=ON;
`)
database.exec('PRAGMA user_version=2')
}

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
      if (!workerData.readOnly) database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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