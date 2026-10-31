import type { Dirent } from 'node:fs';
import path from 'node:path';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  CommandCatalogEntry,
  CommandCatalogGroupId,
  CommandCatalogResponse,
} from '@/shared/types.js';
import { isSubscriptionLimitsSwitchOn } from '@/shared/utils.js';

import { BUILTIN_COMMAND_ROWS, COMMAND_GROUP_LABELS } from './builtin-commands.js';

type CatalogFileSystem = {
  readdir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
};

type CommandsCatalogDependencies = {
  fileSystem: CatalogFileSystem;
  homeDirectory: () => string;
};

const MAX_SCAN_DEPTH = 4;
const MINE_LABEL = 'Мои';

function firstContentLine(content: string): string {
  const line = content.trim().split('\n')[0] ?? '';
  return line.replace(/^#+\s*/, '').trim();
}

function frontmatterText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function makeEntry(
  fields: Partial<CommandCatalogEntry> & Pick<CommandCatalogEntry, 'name' | 'group' | 'source'>,
): CommandCatalogEntry {
  const label = COMMAND_GROUP_LABELS.find((group) => group.id === fields.group)?.label ?? MINE_LABEL;
  return {
    id: `${fields.source}:${fields.name}`,
    args: '',
    description: '',
    groupLabel: label,
    shortcut: null,
    execution: 'sdk',
    panelAction: null,
    path: null,
    ...fields,
  };
}

/**
 * Creates the service that assembles the slash-command catalog: built-in commands,
 * markdown command files (project and `~/.claude/commands`) and skills. Used by the
 * Commands Catalog router and, via the barrel, by the Search service for command hits.
 * File access is injected so tests run against an in-memory tree.
 */
export function createCommandsCatalogService(dependencies: CommandsCatalogDependencies) {
  const { fileSystem } = dependencies;

  async function scanCommandFiles(
    baseDir: string,
    source: 'project' | 'user',
    dir = baseDir,
    depth = 0,
  ): Promise<CommandCatalogEntry[]> {
    let entries: Dirent[];
    try {
      entries = await fileSystem.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const found: CommandCatalogEntry[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
        found.push(...await scanCommandFiles(baseDir, source, fullPath, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const { data, content } = parseFrontMatter(await fileSystem.readFile(fullPath, 'utf8'));
          const name = `/${path.relative(baseDir, fullPath).replace(/\.md$/, '').replace(/\\/g, '/')}`;
          found.push(makeEntry({
            name,
            group: 'mine',
            source,
            execution: 'custom',
            description: frontmatterText(data.description) || firstContentLine(content),
            args: frontmatterText(data['argument-hint']),
            path: fullPath,
          }));
        } catch {
          // An unreadable command file must not hide the other commands.
        }
      }
    }
    return found;
  }

  async function scanSkillDirectory(
    skillsDir: string,
    source: 'skill' | 'plugin',
  ): Promise<CommandCatalogEntry[]> {
    let entries: Dirent[];
    try {
      entries = await fileSystem.readdir(skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const found: CommandCatalogEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      try {
        const { data } = parseFrontMatter(await fileSystem.readFile(skillFile, 'utf8'));
        found.push(makeEntry({
          name: `/${frontmatterText(data.name) || entry.name}`,
          group: 'mine',
          source,
          execution: 'skill',
          description: frontmatterText(data.description).replace(/\s+/g, ' ').slice(0, 300),
          args: frontmatterText(data['argument-hint']),
          path: skillFile,
        }));
      } catch {
        // Directories without a readable SKILL.md are not skills.
      }
    }
    return found;
  }

  /** Finds `skills` folders of installed Claude Code plugins (cache/<market>/<plugin>/<version>/skills). */
  async function listPluginSkillDirectories(pluginsDir: string): Promise<string[]> {
    const result: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries: Dirent[];
      try {
        entries = await fileSystem.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(dir, entry.name);
        if (entry.name === 'skills') result.push(child);
        else await walk(child, depth + 1);
      }
    };
    await walk(path.join(pluginsDir, 'cache'), 0);
    return result;
  }

  function buildBuiltinEntries(): CommandCatalogEntry[] {
    // `/usage` shows the subscription limits: left out while the counter is off (MIRAGE_SUBSCRIPTION_LIMITS).
    const rows = BUILTIN_COMMAND_ROWS.filter((row) => row[6] !== 'show_usage' || isSubscriptionLimitsSwitchOn());
    return rows.map(([name, args, description, group, shortcut, execution, panelAction]) =>
      makeEntry({ name, args, description, group, shortcut, execution, panelAction, source: 'builtin' }),
    );
  }

  function groupEntries(commands: CommandCatalogEntry[]): CommandCatalogResponse {
    return {
      groups: COMMAND_GROUP_LABELS.map(({ id, label }) => ({
        id,
        label,
        commands: commands.filter((command) => command.group === (id as CommandCatalogGroupId)),
      })),
      commands,
      count: commands.length,
    };
  }

  return {
    /**
     * Builds the catalog. `projectPath` adds that project's `.claude/commands` and
     * `.claude/skills`; omit it for the global part only.
     */
    async getCatalog(projectPath?: string | null): Promise<CommandCatalogResponse> {
      const claudeDir = path.join(dependencies.homeDirectory(), '.claude');
      const pluginSkillDirs = await listPluginSkillDirectories(path.join(claudeDir, 'plugins'));

      const [projectCommands, userCommands, projectSkills, userSkills, ...pluginSkills] = await Promise.all([
        projectPath ? scanCommandFiles(path.join(projectPath, '.claude', 'commands'), 'project') : [],
        scanCommandFiles(path.join(claudeDir, 'commands'), 'user'),
        projectPath ? scanSkillDirectory(path.join(projectPath, '.claude', 'skills'), 'skill') : [],
        scanSkillDirectory(path.join(claudeDir, 'skills'), 'skill'),
        ...pluginSkillDirs.map((dir) => scanSkillDirectory(dir, 'plugin')),
      ]);

      // Earlier sources win on a name clash: project overrides user overrides plugin.
      const mine: CommandCatalogEntry[] = [];
      const seen = new Set<string>();
      const candidates = [...projectCommands, ...projectSkills, ...userCommands, ...userSkills, ...pluginSkills.flat()];
      for (const entry of candidates) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        mine.push(entry);
      }
      mine.sort((a, b) => a.name.localeCompare(b.name));

      return groupEntries([...buildBuiltinEntries(), ...mine]);
    },
  };
}

/** Service type shared by the catalog router and the module barrel. */
export type CommandsCatalogService = ReturnType<typeof createCommandsCatalogService>;
