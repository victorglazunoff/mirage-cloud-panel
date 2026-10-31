// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { migrateLegacyDataDirs, resolveMirageDataDir } from './data-dirs.js';

// This bootstrap cannot import shared/utils.ts: that module reads environment
// defaults during evaluation, before this file has loaded `.env`. It imports only
// data-dirs.ts, which uses nothing but Node built-ins.
function getBootstrapApplicationRoot(importMetaUrl: string) {
  const moduleDirectory = path.dirname(fileURLToPath(importMetaUrl));
  let serverRoot = moduleDirectory;
  while (path.basename(serverRoot) !== 'server') {
    const parent = path.dirname(serverRoot);
    if (parent === serverRoot) throw new Error('Could not resolve server root');
    serverRoot = parent;
  }
  const parent = path.dirname(serverRoot);
  return path.basename(parent) === 'dist-server' ? path.dirname(parent) : parent;
}

// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.ts and /dist-server/server/load-env.js.
const APP_ROOT = getBootstrapApplicationRoot(import.meta.url);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e: any) {
  // No .env is the normal case (all settings are optional): say it calmly, keep real read errors loud.
  // stderr, so `mirage --version` and other CLI output stay clean for scripts.
  if (e?.code === 'ENOENT') {
    console.error('No .env file — using defaults (see .env.example).');
  } else {
    console.error('Could not read .env:', e.message);
  }
}

// The panel's data folder (~/.mirage or MIRAGE_DATA_DIR). On the first start after
// CloudCLI UI its ~/.cloudcli and ~/.claude-code-ui are copied in (the old ones stay).
const DATA_DIR = resolveMirageDataDir(process.env, os.homedir());
migrateLegacyDataDirs({
  homeDir: os.homedir(),
  dataDir: DATA_DIR,
  databasePathIsExplicit: Boolean(process.env.DATABASE_PATH),
  log: (message) => console.log(message),
});

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(DATA_DIR, 'auth.db');
}
