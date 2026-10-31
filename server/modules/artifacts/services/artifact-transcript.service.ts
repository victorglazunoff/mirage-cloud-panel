import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import type { AnyRecord, ArtifactKind, ArtifactPublishRecord } from '@/shared/types.js';
import { readArtifactPublication, readObjectRecord } from '@/shared/utils.js';

/** Tool `action` values that publish a version; every other action (`list`, `read`, …) is a service call. */
const PUBLISHING_ACTIONS = new Set([undefined, 'publish']);

/**
 * Used here and by the artifact store (to check a requested frame file).
 * Normalizes a path an Artifact is published at (`img/a.jpg`, `project/Main.dc.html`).
 * Returns `null` for anything that could leave the version folder: absolute
 * paths, `..` segments, empty names.
 */
export function normalizePublishedPath(value: string): string | null {
  const unified = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!unified || unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    return null;
  }

  const normalized = path.posix.normalize(unified);
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || normalized === '..'
    || normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    return null;
  }
  return normalized;
}

/** Joins the text of a tool result, which is a string or an array of `{ type: 'text', text }` blocks. */
function readResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

/** Reads the quoted list after "Its own files now:" in a typed Artifact's result text. */
function readOwnFiles(resultText: string): string[] {
  const match = /Its own files now:\s*((?:"[^"\n]*"(?:,\s*)?)+)/.exec(resultText);
  if (!match) {
    return [];
  }
  const files: string[] = [];
  for (const quoted of match[1].matchAll(/"([^"\n]*)"/g)) {
    const normalized = normalizePublishedPath(quoted[1]);
    if (normalized && !files.includes(normalized)) {
      files.push(normalized);
    }
  }
  return files;
}

function resolveAbsolute(value: unknown, baseDirectory: string | null): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  if (path.isAbsolute(value)) {
    return path.normalize(value);
  }
  return baseDirectory ? path.resolve(baseDirectory, value) : null;
}

function isUnderDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Turns one `Artifact` call and its result into a publish record, or `null`
 * when the call did not publish a version (service actions, asset uploads,
 * failed calls).
 *
 * Used by the transcript reader below and by the live capture in the
 * Artifacts service. `cwd` resolves the relative paths the tool accepts
 * ("relative to the working directory"); without it relative paths are
 * dropped. Supporting files are read from the call: `files` as a list
 * (`[{ path }]`, published at their own path under `root`) or as a map
 * (`{ published: source | { from } }`); copies from another Artifact and
 * removals (`null`) are skipped. For a typed Artifact the "own files" named in
 * the result are added, resolved under its root.
 */
export function buildArtifactPublishRecord(input: {
  toolUseId: string;
  toolInput: unknown;
  toolUseResult: unknown;
  resultText: string;
  publishedAt: string | null;
  cwd: string | null;
}): ArtifactPublishRecord | null {
  const publication = readArtifactPublication(input.toolUseResult);
  if (!publication) {
    return null;
  }

  const toolInput = readObjectRecord(input.toolInput) ?? {};
  const action = typeof toolInput.action === 'string' ? toolInput.action : undefined;
  if (!PUBLISHING_ACTIONS.has(action) || toolInput.asset === true) {
    return null;
  }

  const entrySourcePath = resolveAbsolute(toolInput.file_path, input.cwd)
    ?? resolveAbsolute(publication.localPath, null);
  const ownFiles = readOwnFiles(input.resultText);

  const isTyped = /comes from the Artifact type/.test(input.resultText)
    || typeof toolInput.type_url === 'string'
    || ownFiles.some((file) => file.endsWith('.dc.html'))
    || (entrySourcePath !== null && path.basename(entrySourcePath) === 'canvas.json');
  let kind: ArtifactKind = 'page';
  if (isTyped) {
    kind = 'typed';
  } else if (entrySourcePath && /\.(md|markdown)$/i.test(entrySourcePath)) {
    kind = 'markdown';
  }

  let sourceRoot = resolveAbsolute(toolInput.root, input.cwd);
  if (!sourceRoot && entrySourcePath) {
    // A typed Artifact's file_path is one of its own files (`project/canvas.json`):
    // the root is what is left once that published path is cut off.
    const ownMatch = ownFiles.find((file) => entrySourcePath.endsWith(`${path.sep}${file.split('/').join(path.sep)}`));
    sourceRoot = ownMatch
      ? entrySourcePath.slice(0, entrySourcePath.length - ownMatch.length - 1)
      : path.dirname(entrySourcePath);
  }

  const supportingFiles: ArtifactPublishRecord['supportingFiles'] = [];
  const addSupportingFile = (publishedValue: string, sourceValue: string): void => {
    const publishedPath = normalizePublishedPath(publishedValue);
    const sourcePath = resolveAbsolute(sourceValue, sourceRoot ?? input.cwd);
    if (!publishedPath || !sourcePath) {
      return;
    }
    if (supportingFiles.some((file) => file.publishedPath === publishedPath)) {
      return;
    }
    supportingFiles.push({ publishedPath, sourcePath });
  };

  if (Array.isArray(toolInput.files)) {
    for (const entry of toolInput.files as unknown[]) {
      const filePath = typeof entry === 'string' ? entry : readObjectRecord(entry)?.path;
      if (typeof filePath === 'string') {
        addSupportingFile(filePath, filePath);
      }
    }
  } else {
    const fileMap = readObjectRecord(toolInput.files);
    for (const [publishedPath, source] of Object.entries(fileMap ?? {})) {
      if (typeof source === 'string') {
        addSupportingFile(publishedPath, source);
        continue;
      }
      const from = readObjectRecord(source)?.from;
      if (typeof from === 'string') {
        addSupportingFile(publishedPath, from);
      }
    }
  }

  if (kind === 'typed' && sourceRoot) {
    for (const file of ownFiles) {
      addSupportingFile(file, file);
    }
  }

  // The entry itself is served from its published path; it is copied with the
  // supporting files, never listed twice.
  if (entrySourcePath && sourceRoot && isUnderDirectory(entrySourcePath, sourceRoot)) {
    const entryPublished = path.relative(sourceRoot, entrySourcePath).split(path.sep).join('/');
    const existingIndex = supportingFiles.findIndex((file) => file.publishedPath === entryPublished);
    if (existingIndex >= 0) {
      supportingFiles.splice(existingIndex, 1);
    }
  }

  return {
    ...publication,
    localPath: publication.localPath ?? entrySourcePath,
    toolUseId: input.toolUseId,
    publishedAt: input.publishedAt,
    kind,
    label: typeof toolInput.label === 'string' && toolInput.label ? toolInput.label : null,
    description: typeof toolInput.description === 'string' && toolInput.description
      ? toolInput.description
      : null,
    icon: publication.icon ?? (typeof toolInput.icon === 'string' && toolInput.icon ? toolInput.icon : null),
    entrySourcePath,
    sourceRoot,
    supportingFiles,
    ownFiles,
  };
}

/**
 * Reads every Artifact publish recorded in one Claude session transcript, in
 * file order. Used by the Artifacts service to list a session's Artifacts and
 * to find the version a view asks for.
 *
 * Only the lines that can matter are parsed (a transcript can be hundreds of
 * megabytes). A publish is recognised by its structured result; the matching
 * `tool_use` adds the call's paths and labels. A publish seen twice (a forked
 * transcript repeats its parent's rows) is kept once.
 */
export async function readSessionArtifactPublishes(
  jsonlPath: string,
  cwd: string | null,
): Promise<ArtifactPublishRecord[]> {
  const toolInputs = new Map<string, unknown>();
  const records: ArtifactPublishRecord[] = [];
  const seen = new Set<string>();

  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.includes('"Artifact"') && !line.includes('"artifact_id"')) {
      continue;
    }

    let row: AnyRecord;
    try {
      row = JSON.parse(line) as AnyRecord;
    } catch {
      // A row can be half-written while the CLI is streaming into the file.
      continue;
    }

    const content = row.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }

    if (row.message?.role === 'assistant') {
      for (const part of content as AnyRecord[]) {
        if (part?.type === 'tool_use' && part.name === 'Artifact' && typeof part.id === 'string') {
          toolInputs.set(part.id, part.input);
        }
      }
      continue;
    }

    const toolResults = (content as AnyRecord[]).filter((part) => part?.type === 'tool_result');
    // The structured result sits on the row, so it belongs to the row's only
    // tool result — or, when there are several, to the one that called Artifact.
    const artifactResults = toolResults.length === 1
      ? toolResults
      : toolResults.filter((part) => toolInputs.has(String(part.tool_use_id)));
    if (artifactResults.length !== 1) {
      continue;
    }

    const toolResult = artifactResults[0];
    const toolUseId = String(toolResult.tool_use_id ?? '');
    const record = buildArtifactPublishRecord({
      toolUseId,
      toolInput: toolInputs.get(toolUseId),
      toolUseResult: row.toolUseResult,
      resultText: readResultText(toolResult.content),
      publishedAt: typeof row.timestamp === 'string' ? row.timestamp : null,
      cwd: typeof row.cwd === 'string' ? row.cwd : cwd,
    });
    if (!record) {
      continue;
    }

    const key = `${record.artifactId}\u0000${record.version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    records.push(record);
  }

  return records;
}
