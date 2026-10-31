import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { ArtifactPublishRecord, ArtifactStoredManifest } from '@/shared/types.js';
import { resolvePathUnderRoots } from '@/shared/utils.js';
import { normalizePublishedPath } from '@/modules/artifacts/services/artifact-transcript.service.js';

/** The Artifact tool's own cap on one file; anything larger was never published. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Cap on one stored version, matching one publish of the tool (64 MB). */
const MAX_VERSION_BYTES = 64 * 1024 * 1024;
/** Cap on the files of one stored version (the tool's per-version limit). */
const MAX_VERSION_FILES = 511;

/** Names never copied even under an allowed root: keys, credentials, the panel's own data. */
const DENIED_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.mirage', '.cloudcli', '.password-store', '.git']);
const DENIED_BASENAMES = [/^\.env(\..*)?$/i, /\.env$/i, /^\.credentials\.json$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx)$/i];

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SAFE_VERSION_DIR = /^[A-Za-z0-9._-]{1,100}$/;

/** Index kept per Artifact (`artifact.json`): which sessions published it. */
type ArtifactIndex = {
  artifactId: string;
  sessionIds: string[];
  title: string;
  url: string;
  updatedAt: string;
};

/**
 * Used by the Artifacts service for ids taken from a request: true when the id
 * is safe to use as one folder name in the store.
 */
export function isSafeArtifactId(value: string): boolean {
  return SAFE_ID.test(value);
}

/**
 * Used by the Artifacts service and the store: the folder one version is kept
 * in. The claude.ai version id (`1792985837-69e0`) when it is a safe name,
 * else `seq-<n>`; `null` when neither is usable.
 */
export function readVersionDirName(record: { version: string; seq: number | null }): string | null {
  if (SAFE_VERSION_DIR.test(record.version) && record.version !== '.' && record.version !== '..') {
    return record.version;
  }
  return record.seq !== null ? `seq-${record.seq}` : null;
}

/**
 * Used by the store before copying and exported for its tests: true when a
 * real path names a secret or the panel's own data, which is never copied even
 * when it lies under an allowed root (a project at the home folder covers
 * `~/.ssh`).
 */
export function isDeniedSourcePath(realPath: string): boolean {
  const segments = realPath.split(path.sep);
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = path.basename(realPath);
  return DENIED_BASENAMES.some((pattern) => pattern.test(basename));
}

function artifactDirectory(storeRoot: string, artifactId: string): string {
  if (!isSafeArtifactId(artifactId)) {
    throw new Error(`Unsafe artifact id: ${artifactId}`);
  }
  return path.join(storeRoot, artifactId);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(temporaryPath, filePath);
}

/**
 * Used by the Artifacts service: the manifest of one stored version, or `null`
 * when that version was never stored.
 */
export async function readStoredManifest(
  storeRoot: string,
  artifactId: string,
  versionDir: string,
): Promise<ArtifactStoredManifest | null> {
  if (!isSafeArtifactId(artifactId) || !SAFE_VERSION_DIR.test(versionDir) || versionDir.startsWith('.')) {
    return null;
  }
  return readJsonFile<ArtifactStoredManifest>(
    path.join(artifactDirectory(storeRoot, artifactId), versionDir, 'manifest.json'),
  );
}

/**
 * Used by the Artifacts service: every stored version of an Artifact, newest
 * (highest `seq`) first.
 */
export async function readStoredVersions(storeRoot: string, artifactId: string): Promise<ArtifactStoredManifest[]> {
  if (!isSafeArtifactId(artifactId)) {
    return [];
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(artifactDirectory(storeRoot, artifactId));
  } catch {
    return [];
  }

  const manifests: ArtifactStoredManifest[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'artifact.json') {
      continue;
    }
    const manifest = await readStoredManifest(storeRoot, artifactId, entry);
    if (manifest) {
      manifests.push(manifest);
    }
  }
  return manifests.sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0));
}

/**
 * Used by the Artifacts service to serve a frame file: the bytes of one stored
 * file, or `null`. `publishedPath` comes from a URL, so it is normalized and
 * must stay inside the version's `files/` folder, which holds no links (the
 * store writes plain copies only).
 */
export async function readStoredFile(
  storeRoot: string,
  manifest: ArtifactStoredManifest,
  publishedPath: string,
): Promise<Buffer | null> {
  const normalized = normalizePublishedPath(publishedPath);
  if (!normalized || !manifest.files.includes(normalized)) {
    return null;
  }

  const filesDirectory = path.join(artifactDirectory(storeRoot, manifest.artifactId), manifest.versionDir, 'files');
  const filePath = path.resolve(filesDirectory, ...normalized.split('/'));
  if (!filePath.startsWith(`${filesDirectory}${path.sep}`)) {
    return null;
  }

  try {
    const stat = await fsp.lstat(filePath);
    return stat.isFile() ? await fsp.readFile(filePath) : null;
  } catch {
    return null;
  }
}

/**
 * Used by the Artifacts service: the sessions that published an Artifact, as
 * remembered in its `artifact.json` (newest session last).
 */
export async function readArtifactSessionIds(storeRoot: string, artifactId: string): Promise<string[]> {
  if (!isSafeArtifactId(artifactId)) {
    return [];
  }
  const index = await readJsonFile<ArtifactIndex>(path.join(artifactDirectory(storeRoot, artifactId), 'artifact.json'));
  return Array.isArray(index?.sessionIds) ? index.sessionIds.filter((id) => typeof id === 'string') : [];
}

/**
 * Used by the Artifacts service: remembers that `sessionId` published the
 * Artifact, so a view by Artifact id alone can find its transcript again.
 * Writes only when something changed.
 */
export async function rememberArtifactSession(
  storeRoot: string,
  record: { artifactId: string; title: string; url: string },
  sessionId: string,
): Promise<void> {
  const directory = artifactDirectory(storeRoot, record.artifactId);
  const indexPath = path.join(directory, 'artifact.json');
  const existing = await readJsonFile<ArtifactIndex>(indexPath);
  const sessionIds = Array.isArray(existing?.sessionIds) ? existing.sessionIds : [];
  if (existing && sessionIds.includes(sessionId) && existing.title === record.title && existing.url === record.url) {
    return;
  }

  await fsp.mkdir(directory, { recursive: true });
  await writeJsonAtomically(indexPath, {
    artifactId: record.artifactId,
    sessionIds: [...sessionIds.filter((id) => id !== sessionId), sessionId],
    title: record.title,
    url: record.url,
    updatedAt: new Date().toISOString(),
  } satisfies ArtifactIndex);
}

/** Copies the files of the newest stored version older than `seq`: a publish keeps the files it did not resend. */
async function copyPreviousVersionFiles(
  storeRoot: string,
  record: ArtifactPublishRecord,
  targetFilesDirectory: string,
): Promise<string[]> {
  if (record.seq === null) {
    return [];
  }
  const previous = (await readStoredVersions(storeRoot, record.artifactId))
    .find((manifest) => manifest.seq !== null && manifest.seq < (record.seq as number));
  if (!previous || previous.files.length === 0) {
    return [];
  }

  const sourceDirectory = path.join(artifactDirectory(storeRoot, record.artifactId), previous.versionDir, 'files');
  await fsp.cp(sourceDirectory, targetFilesDirectory, { recursive: true, verbatimSymlinks: true });
  return [...previous.files];
}

/**
 * Used by the Artifacts service (live publishes and backfill of older
 * sessions): copies one published version into
 * `<storeRoot>/<artifactId>/<versionDir>/` and returns its manifest. A
 * version already stored with its entry file is returned as is.
 *
 * Every source path comes from the transcript, never from a request, and is
 * still checked: it must resolve (links followed) under one of `allowedRoots`,
 * must not be a secret (`isDeniedSourcePath`), must be a regular file of at
 * most 16 MB, and the version stays within 64 MB / 511 files. Whatever is
 * refused is listed in `skipped`. A version whose entry could not be copied
 * still gets a manifest (entry `null`), so the panel can say the copy is
 * missing; a later capture retries it.
 */
export async function captureArtifactVersion(input: {
  storeRoot: string;
  record: ArtifactPublishRecord;
  allowedRoots: string[];
  origin: ArtifactStoredManifest['origin'];
}): Promise<ArtifactStoredManifest | null> {
  const { storeRoot, record, allowedRoots, origin } = input;
  const versionDir = readVersionDirName(record);
  if (!versionDir || !isSafeArtifactId(record.artifactId)) {
    return null;
  }

  const existing = await readStoredManifest(storeRoot, record.artifactId, versionDir);
  if (existing && (existing.entryPath !== null || record.kind === 'typed')) {
    return existing;
  }

  const directory = artifactDirectory(storeRoot, record.artifactId);
  await fsp.mkdir(directory, { recursive: true });
  const workDirectory = path.join(directory, `.tmp-${randomUUID()}`);
  const filesDirectory = path.join(workDirectory, 'files');
  await fsp.mkdir(filesDirectory, { recursive: true });

  try {
    const files = new Set(await copyPreviousVersionFiles(storeRoot, record, filesDirectory));
    const skipped: ArtifactStoredManifest['skipped'] = [];
    let totalBytes = 0;
    let modifiedAfterPublish = false;

    const copyOne = async (publishedPath: string, sourcePath: string): Promise<boolean> => {
      const realPath = await resolvePathUnderRoots(sourcePath, allowedRoots);
      if (!realPath) {
        const exists = await fsp.lstat(sourcePath).then(() => true, () => false);
        skipped.push({ path: publishedPath, reason: exists ? 'outside-allowed-roots' : 'missing' });
        return false;
      }
      if (isDeniedSourcePath(realPath)) {
        skipped.push({ path: publishedPath, reason: 'denied' });
        return false;
      }

      const stat = await fsp.stat(realPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        skipped.push({ path: publishedPath, reason: 'not-a-file' });
        return false;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push({ path: publishedPath, reason: 'too-large' });
        return false;
      }
      if (totalBytes + stat.size > MAX_VERSION_BYTES || (!files.has(publishedPath) && files.size >= MAX_VERSION_FILES)) {
        skipped.push({ path: publishedPath, reason: 'version-too-large' });
        return false;
      }

      const target = path.join(filesDirectory, ...publishedPath.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rm(target, { force: true });
      await fsp.copyFile(realPath, target);
      totalBytes += stat.size;
      files.add(publishedPath);

      const publishedAtMs = record.publishedAt ? Date.parse(record.publishedAt) : Number.NaN;
      if (origin === 'backfill' && Number.isFinite(publishedAtMs) && stat.mtimeMs > publishedAtMs + 5000) {
        modifiedAfterPublish = true;
      }
      return true;
    };

    let entryPath: string | null = null;
    if (record.entrySourcePath) {
      const relativeEntry = record.sourceRoot
        ? path.relative(record.sourceRoot, record.entrySourcePath).split(path.sep).join('/')
        : '';
      const publishedEntry = normalizePublishedPath(relativeEntry) ?? path.basename(record.entrySourcePath);
      if (await copyOne(publishedEntry, record.entrySourcePath)) {
        entryPath = publishedEntry;
      }
    }
    for (const file of record.supportingFiles) {
      await copyOne(file.publishedPath, file.sourcePath);
    }

    const manifest: ArtifactStoredManifest = {
      artifactId: record.artifactId,
      versionDir,
      version: record.version,
      seq: record.seq,
      kind: record.kind,
      title: record.title,
      url: record.url,
      icon: record.icon,
      label: record.label,
      publishedAt: record.publishedAt,
      entryPath,
      files: [...files].sort(),
      skipped,
      ownFiles: record.ownFiles,
      capturedAt: new Date().toISOString(),
      origin,
      modifiedAfterPublish,
    };
    await fsp.writeFile(path.join(workDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const finalDirectory = path.join(directory, versionDir);
    if (existing) {
      // Replacing an earlier attempt that had no entry: move it aside first.
      const asideDirectory = path.join(directory, `.old-${randomUUID()}`);
      await fsp.rename(finalDirectory, asideDirectory);
      await fsp.rm(asideDirectory, { recursive: true, force: true });
    }
    try {
      await fsp.rename(workDirectory, finalDirectory);
    } catch (error) {
      // Another capture of the same version won the race: keep its copy.
      const raced = await readStoredManifest(storeRoot, record.artifactId, versionDir);
      if (raced) {
        return raced;
      }
      throw error;
    }
    return manifest;
  } finally {
    await fsp.rm(workDirectory, { recursive: true, force: true });
  }
}
