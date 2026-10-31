// Preloaded into every `npm test` process (`--import`, see package.json).
//
// Tests that touch the database without setting DATABASE_PATH themselves used to
// open whatever DATABASE_PATH the shell had — on a machine that runs the panel,
// the live database — or, with none set, an empty `database/auth.db` in the
// repository, where they failed with «no such table». Each test process now gets
// its own throwaway database with the full schema; tests that need a fresh one
// still point DATABASE_PATH at their own file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { runMigrations } from './modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from './modules/database/schema.js';

type SqliteDatabase = {
  exec(sql: string): void;
  close(): void;
};

const testDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirage-test-'));
const testDatabasePath = path.join(testDataDirectory, 'auth.db');

process.env.DATABASE_PATH = testDatabasePath;

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (file: string) => SqliteDatabase;
const database = new Database(testDatabasePath);
const originalLog = console.log;
console.log = () => undefined; // migration progress lines are noise in test output
try {
  database.exec(INIT_SCHEMA_SQL);
  runMigrations(database as unknown as Parameters<typeof runMigrations>[0]);
} finally {
  console.log = originalLog;
  database.close();
}

process.on('exit', () => {
  fs.rmSync(testDataDirectory, { recursive: true, force: true });
});
