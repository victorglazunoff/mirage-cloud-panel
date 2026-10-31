import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';

/**
 * Read-only view of the server's systemd timers for the calendar
 * («Расписание сервера»). Only `systemctl list-timers/show` and
 * `systemd-analyze calendar` are run — nothing is started, stopped or edited —
 * always through `execFile` with fixed arguments, never a shell.
 */

const COMMAND_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const MAX_OCCURRENCES_PER_TIMER = 200;

/** One timer as the calendar needs it. Times are epoch milliseconds. */
export type ServerTimer = {
  unit: string;
  activates: string | null;
  description: string | null;
  calendarSpecs: string[];
  nextElapseMs: number | null;
  lastTriggerMs: number | null;
  lastResult: string | null;
  /** True for timers shipped by packages (`/usr/lib`, `/lib`), hidden by default. */
  isPackaged: boolean;
  /**
   * The zone its `OnCalendar` wall-clock times are read in: the zone written in
   * the spec («… 05:17 UTC»), else the server's system zone. A zone with summer
   * time (e.g. Europe/Helsinki) moves the firings by an hour in a panel zone
   * without one (MIRAGE_TIMEZONE) twice a year — the calendar explains it from this field.
   */
  timeZone: string | null;
};

/** One timer firing inside the requested range. */
export type ServerTimerOccurrence = { timer: ServerTimer; startsAtMs: number };

/** Runs a fixed command and resolves its stdout; injected in tests. `env` adds variables (e.g. `TZ`). */
export type CommandRunner = (command: string, args: string[], options?: { env?: Record<string, string> }) => Promise<string>;

const runCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const env = options?.env ? { ...process.env, ...options.env } : process.env;
  execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(String(stdout));
  });
});

/** The zone systemd reads calendar specs in: `/etc/localtime` → `…/zoneinfo/Europe/Helsinki`. */
function readSystemTimeZone(): string | null {
  try {
    const target = readlinkSync('/etc/localtime');
    const match = /zoneinfo\/(.+)$/.exec(target);
    if (match) return match[1];
  } catch {
    // Not a symlink (containers): fall back to what Node resolved.
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The zone a calendar spec is read in: its own trailing zone («… 05:17 UTC»,
 * «… 05:17 Europe/Berlin») or the system zone. Exported for the tests.
 */
export function specTimeZone(spec: string, systemZone: string | null): string | null {
  const last = spec.trim().split(/\s+/).pop() ?? '';
  if (/^(UTC|GMT|Z)$/i.test(last)) return 'UTC';
  if (/^[A-Za-z]+\/[\w+/-]+$/.test(last)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: last });
      return last;
    } catch {
      // Not a zone after all.
    }
  }
  return systemZone;
}

function microsecondsToMs(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? Math.floor(value / 1000) : null;
}

/** Parses `systemctl show` output (blocks of `Key=Value` separated by blank lines). */
function parseShowBlocks(output: string): Array<Map<string, string[]>> {
  return output
    .split(/\n\s*\n/)
    .map((block) => {
      const fields = new Map<string, string[]>();
      for (const line of block.split('\n')) {
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        fields.set(key, [...(fields.get(key) ?? []), line.slice(separator + 1)]);
      }
      return fields;
    })
    .filter((fields) => fields.has('Id'));
}

/**
 * Extracts UTC instants from `systemd-analyze calendar --iterations=N` output.
 * When the system zone is not UTC each elapse has an "(in UTC)" line; when it
 * is, the elapse line itself is in UTC — either way only UTC lines are read.
 */
export function parseCalendarElapses(output: string): number[] {
  const instants: number[] = [];
  for (const line of output.split('\n')) {
    const match = /:\s+\w{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC\s*$/.exec(line);
    if (match && /(Next elapse|Iteration #\d+|\(in UTC\))/.test(line)) {
      instants.push(Date.parse(`${match[1]}T${match[2]}Z`));
    }
  }
  return [...new Set(instants)].sort((a, b) => a - b);
}

/**
 * Creates the timer reader. Results are cached for a minute so a calendar
 * that re-renders does not fork `systemctl` each time.
 *
 * Used by the calendar service to merge `server_schedule` items.
 */
export function createSystemdTimersService(runner: CommandRunner = runCommand, readSystemZone: () => string | null = readSystemTimeZone) {
  let timersCache: { at: number; timers: ServerTimer[] } | null = null;
  const occurrenceCache = new Map<string, { at: number; instants: number[] }>();

  async function listTimers(nowMs: number): Promise<ServerTimer[]> {
    if (timersCache && nowMs - timersCache.at < CACHE_TTL_MS) {
      return timersCache.timers;
    }
    const listed = JSON.parse(await runner('systemctl', ['list-timers', '--all', '--output=json', '--no-pager'])) as Array<{
      unit?: string; activates?: string; next?: number | null; last?: number | null;
    }>;
    const units = listed.map((entry) => entry.unit).filter((unit): unit is string => typeof unit === 'string' && /^[\w@.:-]+\.timer$/.test(unit));
    if (units.length === 0) {
      timersCache = { at: nowMs, timers: [] };
      return [];
    }

    const systemZone = readSystemZone();
    const timerBlocks = parseShowBlocks(await runner('systemctl', [
      'show', '-p', 'Id', '-p', 'Description', '-p', 'TimersCalendar',
      '-p', 'FragmentPath', '-p', 'Unit', '--', ...units,
    ]));
    const services = [...new Set(listed.map((entry) => entry.activates).filter((unit): unit is string => typeof unit === 'string' && /^[\w@.:-]+$/.test(unit)))];
    const serviceResults = new Map<string, string>();
    if (services.length > 0) {
      try {
        for (const block of parseShowBlocks(await runner('systemctl', ['show', '-p', 'Id', '-p', 'Result', '--', ...services]))) {
          serviceResults.set(block.get('Id')?.[0] ?? '', block.get('Result')?.[0] ?? '');
        }
      } catch {
        // Results are decoration; the schedule itself is still worth showing.
      }
    }

    const timers = timerBlocks.map((block): ServerTimer => {
      const unit = block.get('Id')?.[0] ?? '';
      const listedEntry = listed.find((entry) => entry.unit === unit);
      const activates = block.get('Unit')?.[0] || listedEntry?.activates || null;
      const fragmentPath = block.get('FragmentPath')?.[0] ?? '';
      const calendarSpecs = (block.get('TimersCalendar') ?? [])
        .map((value) => /OnCalendar=(.+?)\s*;/.exec(value)?.[1]?.trim() ?? '')
        .filter(Boolean);
      return {
        unit,
        activates,
        description: block.get('Description')?.[0] || null,
        calendarSpecs,
        nextElapseMs: microsecondsToMs(listedEntry?.next),
        lastTriggerMs: microsecondsToMs(listedEntry?.last),
        lastResult: activates ? serviceResults.get(activates) || null : null,
        isPackaged: /^\/(usr\/)?lib\//.test(fragmentPath),
        timeZone: calendarSpecs.length ? specTimeZone(calendarSpecs[0], systemZone) : null,
      };
    });
    timersCache = { at: nowMs, timers };
    return timers;
  }

  async function expandSpec(spec: string, fromMs: number, toMs: number, nowMs: number): Promise<number[]> {
    const key = `${spec}|${fromMs}|${toMs}`;
    const cached = occurrenceCache.get(key);
    if (cached && nowMs - cached.at < CACHE_TTL_MS) {
      return cached.instants;
    }
    const output = await runner('systemd-analyze', [
      'calendar', `--iterations=${MAX_OCCURRENCES_PER_TIMER}`, `--base-time=@${Math.floor(fromMs / 1000) - 1}`, '--', spec,
    ]);
    const instants = parseCalendarElapses(output).filter((instant) => instant >= fromMs && instant < toMs);
    if (occurrenceCache.size > 500) occurrenceCache.clear();
    occurrenceCache.set(key, { at: nowMs, instants });
    return instants;
  }

  return {
    /**
     * Firings of the server's timers inside `[fromMs, toMs)`. Calendar timers
     * are expanded with `systemd-analyze`; monotonic ones (`OnBootSec`,
     * `OnUnitActiveSec`) only show their next elapse. Any failure (no systemd,
     * no permission) yields an empty list rather than breaking the calendar.
     */
    async listOccurrences(input: { fromMs: number; toMs: number; nowMs: number; includePackaged: boolean }): Promise<ServerTimerOccurrence[]> {
      let timers: ServerTimer[];
      try {
        timers = await listTimers(input.nowMs);
      } catch {
        return [];
      }
      const occurrences: ServerTimerOccurrence[] = [];
      for (const timer of timers) {
        if (timer.isPackaged && !input.includePackaged) continue;
        const instants = new Set<number>();
        for (const spec of timer.calendarSpecs) {
          try {
            for (const instant of await expandSpec(spec, input.fromMs, input.toMs, input.nowMs)) instants.add(instant);
          } catch {
            // An unparsable spec only costs that timer its occurrences.
          }
        }
        if (timer.calendarSpecs.length === 0 && timer.nextElapseMs !== null
          && timer.nextElapseMs >= input.fromMs && timer.nextElapseMs < input.toMs) {
          instants.add(timer.nextElapseMs);
        }
        for (const startsAtMs of [...instants].sort((a, b) => a - b)) {
          occurrences.push({ timer, startsAtMs });
        }
      }
      return occurrences;
    },

    /**
     * «Открыть журнал»: the last lines of the journal of the service a timer
     * starts. Only a timer the server actually lists is accepted, so the
     * route cannot be used to read the journal of an arbitrary unit. Times are
     * printed in `timeZone` (the panel's), so they match the calendar instead
     * of the server's own zone.
     */
    async readJournal(timerUnit: string, nowMs: number, timeZone: string, lines = 60): Promise<{ unit: string; service: string; lines: string[] } | null> {
      const timers = await listTimers(nowMs);
      const timer = timers.find((candidate) => candidate.unit === timerUnit);
      if (!timer) return null;
      const service = timer.activates || timerUnit.replace(/\.timer$/, '.service');
      const output = await runner('journalctl', ['-u', service, '-n', String(lines), '--no-pager', '-o', 'short-iso', '--'], { env: { TZ: timeZone } });
      return { unit: timer.unit, service, lines: output.split('\n').filter((line) => line.trim()) };
    },
  };
}
