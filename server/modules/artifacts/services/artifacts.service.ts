import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import mime from 'mime-types';

import type {
  ArtifactFrameResponse,
  ArtifactPublishRecord,
  ArtifactStoredManifest,
  ArtifactSummary,
  ArtifactViewTicket,
  ArtifactsRouteServices,
  NormalizedMessage,
  SessionArtifactsResponse,
} from '@/shared/types.js';
import { createNormalizedMessage, readArtifactPublication, readObjectRecord } from '@/shared/utils.js';
import {
  captureArtifactVersion,
  isSafeArtifactId,
  readArtifactSessionIds,
  readStoredFile,
  readStoredManifest,
  readStoredVersions,
  readVersionDirName,
  rememberArtifactSession,
} from '@/modules/artifacts/services/artifact-store.service.js';
import { buildArtifactPublishRecord, readSessionArtifactPublishes } from '@/modules/artifacts/services/artifact-transcript.service.js';
import {
  createArtifactTicket,
  injectArtifactShim,
  renderArtifactCard,
  renderMarkdownArtifact,
  verifyArtifactTicket,
} from '@/modules/artifacts/services/artifact-view.service.js';

/** How long a frame URL stays valid; long enough for lazy images and a page left open. */
const TICKET_TTL_SECONDS = 60 * 60;
/** `Artifact` calls whose result has not arrived yet, kept per tool-use id. */
const MAX_PENDING_TOOL_INPUTS = 500;

/** A session as the Artifacts service needs it. */
type ArtifactSessionInfo = {
  provider: string;
  jsonlPath: string | null;
  projectPath: string | null;
};

/** What the Artifacts service reads from and writes to outside itself. */
type ArtifactsServiceDependencies = {
  /** Folder the copies are kept in (`~/.mirage/artifacts` beside the panel database). */
  storeRoot: () => string;
  getSession: (sessionId: string) => ArtifactSessionInfo | null;
  /** Working folders of every project the panel knows. */
  listProjectPaths: () => string[];
  /** Sends an extra live event into the session's run; `false` when nothing is live. */
  publishToRun: (sessionId: string, event: NormalizedMessage) => boolean;
  /** Folders scratchpads live in (`/tmp/claude-<uid>`); found on disk when omitted. */
  listScratchpadRoots?: () => Promise<string[]>;
  ticketSecret?: Buffer;
  nowSeconds?: () => number;
  logger?: { warn: (message: string, details?: unknown) => void };
};

async function findScratchpadRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const base of new Set([os.tmpdir(), '/tmp'])) {
    let names: string[] = [];
    try {
      names = await fsp.readdir(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^claude-\d+$/.test(name)) {
        roots.add(path.join(base, name));
      }
    }
  }
  return [...roots];
}

/** A root that would allow the whole disk is never accepted. */
function isUsableRoot(root: string | null | undefined): root is string {
  return typeof root === 'string' && path.isAbsolute(root) && path.parse(root).root !== path.resolve(root);
}

function compareRecordsNewestFirst(left: ArtifactPublishRecord, right: ArtifactPublishRecord): number {
  if (left.seq !== null && right.seq !== null && left.seq !== right.seq) {
    return right.seq - left.seq;
  }
  return Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? '') || 0;
}

function readScreens(ownFiles: string[]): string[] {
  return ownFiles
    .filter((file) => file.endsWith('.dc.html'))
    .map((file) => file.replace(/^.*\//, '').replace(/\.dc\.html$/, ''));
}

/** A live tool result's text: a string, or text blocks the provider sent as JSON. */
function readLiveResultText(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }
  if (!content.startsWith('[')) {
    return content;
  }
  try {
    const blocks = JSON.parse(content) as unknown;
    return Array.isArray(blocks)
      ? blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
      : content;
  } catch {
    return content;
  }
}

async function isExistingFile(filePath: string | null): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function readEntryPublishedPath(record: ArtifactPublishRecord): string | null {
  if (!record.entrySourcePath) {
    return null;
  }
  if (!record.sourceRoot) {
    return path.basename(record.entrySourcePath);
  }
  const relative = path.relative(record.sourceRoot, record.entrySourcePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : path.basename(record.entrySourcePath);
}

/**
 * A publish keeps the files earlier publishes sent and this one did not
 * resend. When the earlier versions were never stored, the newest one picks
 * those files up from the transcript (sources resolved as they were then).
 */
function withInheritedFiles(latest: ArtifactPublishRecord, newestFirst: ArtifactPublishRecord[]): ArtifactPublishRecord {
  const entryPublished = readEntryPublishedPath(latest);
  const supportingFiles = [...latest.supportingFiles];
  const known = new Set([entryPublished, ...supportingFiles.map((file) => file.publishedPath)]);

  for (const older of newestFirst.slice(1)) {
    const olderEntry = readEntryPublishedPath(older);
    const candidates = [
      ...(olderEntry && older.entrySourcePath ? [{ publishedPath: olderEntry, sourcePath: older.entrySourcePath }] : []),
      ...older.supportingFiles,
    ];
    for (const file of candidates) {
      if (!known.has(file.publishedPath)) {
        known.add(file.publishedPath);
        supportingFiles.push(file);
      }
    }
  }
  return { ...latest, supportingFiles };
}

/** Builds the list entry of one Artifact from its publishes (newest first). */
function summarize(
  versions: ArtifactPublishRecord[],
  storedDirs: Set<string>,
  localPathExists: boolean,
): ArtifactSummary {
  const latest = versions[0];
  const isStored = (record: ArtifactPublishRecord): boolean => {
    const versionDir = readVersionDirName(record);
    return versionDir !== null && storedDirs.has(versionDir);
  };
  const ownFiles = versions.find((record) => record.ownFiles.length > 0)?.ownFiles ?? [];

  return {
    artifactId: latest.artifactId,
    url: latest.url,
    title: latest.title,
    version: latest.version,
    seq: latest.seq,
    updated: latest.updated,
    icon: versions.find((record) => record.icon)?.icon ?? null,
    localPath: latest.entrySourcePath ?? latest.localPath,
    kind: latest.kind,
    publishedAt: latest.publishedAt,
    description: versions.find((record) => record.description)?.description ?? null,
    label: latest.label,
    localPathExists,
    stored: isStored(latest),
    versionsCount: versions.length,
    versions: versions.map((record) => ({
      version: record.version,
      seq: record.seq,
      publishedAt: record.publishedAt,
      label: record.label,
      stored: isStored(record),
    })),
    screens: readScreens(ownFiles),
    ownFiles,
  };
}

/**
 * Used by the Artifacts composition root: the service behind the routes and
 * the live capture. Lists a session's Artifacts from its transcript, keeps a
 * copy of every version it can (live publishes at once, older sessions'
 * newest versions when listed or viewed), and serves stored versions to the
 * sandboxed frame.
 */
export function createArtifactsService(dependencies: ArtifactsServiceDependencies): ArtifactsRouteServices & {
  handleLiveEvent: (appSessionId: string, event: NormalizedMessage) => void;
  /** Resolves when every capture started by live events has finished (tests, shutdown). */
  whenIdle: () => Promise<void>;
} {
  const ticketSecret = dependencies.ticketSecret ?? randomBytes(32);
  const nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const listScratchpadRoots = dependencies.listScratchpadRoots ?? findScratchpadRoots;
  const logger = dependencies.logger ?? { warn: (message: string, details?: unknown) => console.warn(message, details ?? '') };
  const pendingToolInputs = new Map<string, unknown>();
  const inFlightCaptures = new Map<string, Promise<ArtifactStoredManifest | null>>();
  const liveTasks = new Set<Promise<void>>();

  async function readAllowedRoots(session: ArtifactSessionInfo): Promise<string[]> {
    const roots = [
      ...await listScratchpadRoots(),
      session.projectPath,
      ...dependencies.listProjectPaths(),
    ].filter(isUsableRoot);
    return [...new Set(roots)];
  }

  /** One capture per version at a time; a second caller waits for the first. */
  function capture(
    record: ArtifactPublishRecord,
    session: ArtifactSessionInfo,
    origin: ArtifactStoredManifest['origin'],
  ): Promise<ArtifactStoredManifest | null> {
    const key = `${record.artifactId}/${readVersionDirName(record) ?? ''}`;
    const running = inFlightCaptures.get(key);
    if (running) {
      return running;
    }

    const task = (async () => {
      try {
        return await captureArtifactVersion({
          storeRoot: dependencies.storeRoot(),
          record,
          allowedRoots: await readAllowedRoots(session),
          origin,
        });
      } catch (error) {
        logger.warn('[Artifacts] Failed to store an Artifact version', {
          artifactId: record.artifactId,
          version: record.version,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        inFlightCaptures.delete(key);
      }
    })();
    inFlightCaptures.set(key, task);
    return task;
  }

  async function readSessionRecords(session: ArtifactSessionInfo): Promise<ArtifactPublishRecord[]> {
    if (!session.jsonlPath || session.provider !== 'claude') {
      return [];
    }
    try {
      return await readSessionArtifactPublishes(session.jsonlPath, session.projectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn('[Artifacts] Failed to read a session transcript', {
          jsonlPath: session.jsonlPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  }

  /** Stores the newest version when it is not stored yet and its source still exists. */
  async function backfillLatest(
    latest: ArtifactPublishRecord,
    session: ArtifactSessionInfo,
    storedDirs: Set<string>,
    localPathExists: boolean,
  ): Promise<void> {
    const versionDir = readVersionDirName(latest);
    if (!versionDir || storedDirs.has(versionDir) || (!localPathExists && latest.kind !== 'typed')) {
      return;
    }
    const manifest = await capture(latest, session, 'backfill');
    if (manifest && (manifest.entryPath !== null || manifest.kind === 'typed')) {
      storedDirs.add(versionDir);
    }
  }

  async function listSessionArtifacts(sessionId: string): Promise<SessionArtifactsResponse | null> {
    const session = dependencies.getSession(sessionId);
    if (!session) {
      return null;
    }

    const recordsByArtifact = new Map<string, ArtifactPublishRecord[]>();
    for (const record of await readSessionRecords(session)) {
      if (!isSafeArtifactId(record.artifactId)) {
        continue;
      }
      const list = recordsByArtifact.get(record.artifactId) ?? [];
      list.push(record);
      recordsByArtifact.set(record.artifactId, list);
    }

    const storeRoot = dependencies.storeRoot();
    const artifacts: ArtifactSummary[] = [];
    for (const [artifactId, records] of recordsByArtifact) {
      records.sort(compareRecordsNewestFirst);
      const latest = records[0];
      const storedDirs = new Set(
        (await readStoredVersions(storeRoot, artifactId))
          .filter((manifest) => manifest.entryPath !== null || manifest.kind === 'typed')
          .map((manifest) => manifest.versionDir),
      );
      const localPathExists = await isExistingFile(latest.entrySourcePath);
      await backfillLatest(withInheritedFiles(latest, records), session, storedDirs, localPathExists);
      await rememberArtifactSession(storeRoot, latest, sessionId).catch((error: unknown) => {
        logger.warn('[Artifacts] Failed to index an Artifact', {
          artifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      artifacts.push(summarize(records, storedDirs, localPathExists));
    }

    artifacts.sort((left, right) => Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? '') || 0);
    return { sessionId, artifacts };
  }

  async function createViewTicket(input: {
    artifactId: string;
    version: string | null;
    sessionId: string | null;
  }): Promise<ArtifactViewTicket | null> {
    if (!isSafeArtifactId(input.artifactId)) {
      return null;
    }
    const storeRoot = dependencies.storeRoot();

    // The Artifact must belong to a session that still exists: the one named,
    // or one that published it before (newest first).
    const candidateSessionIds = input.sessionId
      ? [input.sessionId]
      : (await readArtifactSessionIds(storeRoot, input.artifactId)).reverse();

    for (const sessionId of candidateSessionIds) {
      const session = dependencies.getSession(sessionId);
      if (!session) {
        continue;
      }
      const records = (await readSessionRecords(session))
        .filter((record) => record.artifactId === input.artifactId)
        .sort(compareRecordsNewestFirst);
      if (records.length === 0) {
        continue;
      }

      const target = input.version
        ? records.find((record) => record.version === input.version || String(record.seq) === input.version)
        : records[0];
      if (!target) {
        return null;
      }
      const versionDir = readVersionDirName(target);
      if (!versionDir) {
        return null;
      }

      let manifest = await readStoredManifest(storeRoot, target.artifactId, versionDir);
      if (!manifest || (manifest.entryPath === null && target === records[0])) {
        // Only the newest version can be copied from disk: the source file now
        // holds the newest content, not an older version's. An older version
        // that was never stored gets a "copy missing" card instead.
        manifest = target === records[0]
          ? await capture(withInheritedFiles(target, records), session, 'backfill')
          : await captureArtifactVersion({
            storeRoot,
            record: { ...target, entrySourcePath: null, supportingFiles: [] },
            allowedRoots: [],
            origin: 'backfill',
          }).catch(() => null);
      }
      if (!manifest) {
        return null;
      }
      await rememberArtifactSession(storeRoot, target, sessionId).catch(() => undefined);

      const expiresAt = nowSeconds() + TICKET_TTL_SECONDS;
      const ticket = createArtifactTicket({ artifactId: target.artifactId, versionDir, expiresAt }, ticketSecret);
      return {
        url: `/api/artifacts/${encodeURIComponent(target.artifactId)}/frame/${ticket}/`,
        artifactId: target.artifactId,
        version: target.version,
        seq: target.seq,
        kind: target.kind,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      };
    }

    return null;
  }

  async function renderFrame(input: {
    artifactId: string;
    ticket: string;
    filePath: string;
  }): Promise<ArtifactFrameResponse | null> {
    const payload = verifyArtifactTicket(input.ticket, input.artifactId, ticketSecret, nowSeconds());
    if (!payload) {
      return null;
    }
    const storeRoot = dependencies.storeRoot();
    const manifest = await readStoredManifest(storeRoot, payload.artifactId, payload.versionDir);
    if (!manifest) {
      return null;
    }

    const html = (body: string): ArtifactFrameResponse => ({
      body: Buffer.from(body, 'utf8'),
      contentType: 'text/html; charset=utf-8',
      isDocument: true,
    });

    if (input.filePath === '') {
      if (manifest.kind === 'typed' || manifest.entryPath === null) {
        return html(renderArtifactCard(manifest));
      }
      const entry = await readStoredFile(storeRoot, manifest, manifest.entryPath);
      if (!entry) {
        return html(renderArtifactCard({ ...manifest, entryPath: null }));
      }
      return manifest.kind === 'markdown'
        ? html(renderMarkdownArtifact(manifest.title, entry.toString('utf8')))
        : html(injectArtifactShim(entry.toString('utf8')));
    }

    const file = await readStoredFile(storeRoot, manifest, input.filePath);
    if (!file) {
      return null;
    }
    const contentType = mime.contentType(path.extname(input.filePath)) || 'application/octet-stream';
    if (/^text\/html/.test(contentType)) {
      return { body: Buffer.from(injectArtifactShim(file.toString('utf8')), 'utf8'), contentType, isDocument: false };
    }
    return { body: file, contentType, isDocument: false };
  }

  /** Stores a version published in a live turn, then tells the session's tabs. */
  async function captureLivePublish(
    appSessionId: string,
    event: NormalizedMessage,
    toolInput: unknown,
  ): Promise<void> {
    const session = dependencies.getSession(appSessionId);
    if (!session) {
      return;
    }
    const record = buildArtifactPublishRecord({
      toolUseId: event.toolId ?? '',
      toolInput,
      toolUseResult: event.toolUseResult,
      resultText: readLiveResultText(event.content),
      publishedAt: event.timestamp ?? null,
      cwd: session.projectPath,
    });
    if (!record || !isSafeArtifactId(record.artifactId)) {
      return;
    }

    const manifest = await capture(record, session, 'live');
    const storeRoot = dependencies.storeRoot();
    await rememberArtifactSession(storeRoot, record, appSessionId).catch(() => undefined);

    const versionDir = readVersionDirName(record);
    const storedDirs = new Set<string>(
      manifest && versionDir && (manifest.entryPath !== null || manifest.kind === 'typed') ? [versionDir] : [],
    );
    const artifact = summarize([record], storedDirs, await isExistingFile(record.entrySourcePath));
    // The live result only knows this version; claude.ai numbers versions from 1.
    artifact.versionsCount = Math.max(1, record.seq ?? 1);

    dependencies.publishToRun(appSessionId, createNormalizedMessage({
      kind: 'artifact_published',
      sessionId: appSessionId,
      provider: event.provider,
      toolId: event.toolId,
      artifact,
    }));
  }

  function handleLiveEvent(appSessionId: string, event: NormalizedMessage): void {
    if (event.kind === 'tool_use' && event.toolName === 'Artifact' && typeof event.toolId === 'string') {
      pendingToolInputs.set(event.toolId, event.toolInput);
      if (pendingToolInputs.size > MAX_PENDING_TOOL_INPUTS) {
        const oldest = pendingToolInputs.keys().next().value;
        if (oldest !== undefined) {
          pendingToolInputs.delete(oldest);
        }
      }
      return;
    }

    if (event.kind !== 'tool_result') {
      return;
    }
    const toolId = typeof event.toolId === 'string' ? event.toolId : '';
    const hasArtifact = Boolean(readObjectRecord(event.artifact)) || readArtifactPublication(event.toolUseResult) !== null;
    if (!hasArtifact) {
      pendingToolInputs.delete(toolId);
      return;
    }

    const toolInput = pendingToolInputs.get(toolId);
    pendingToolInputs.delete(toolId);
    const task = captureLivePublish(appSessionId, event, toolInput)
      .catch((error: unknown) => {
        logger.warn('[Artifacts] Live capture failed', {
          appSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        liveTasks.delete(task);
      });
    liveTasks.add(task);
  }

  return {
    listSessionArtifacts,
    createViewTicket,
    renderFrame,
    handleLiveEvent,
    whenIdle: async () => {
      while (liveTasks.size > 0) {
        await Promise.all([...liveTasks]);
      }
    },
  };
}
