import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
/** Refresh the access token a minute before Google expires it. */
const TOKEN_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** The subset of a Google Calendar event the sync reads and writes. */
export type GoogleCalendarEvent = {
  id: string;
  etag?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  recurringEventId?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  recurrence?: string[];
  reminders?: { useDefault: boolean; overrides?: Array<{ method: 'popup' | 'email'; minutes: number }> };
  colorId?: string;
};

/** Body of an insert or patch; `id`, `etag` and `updated` are Google's. */
export type GoogleCalendarEventBody = Omit<GoogleCalendarEvent, 'id' | 'etag' | 'updated' | 'recurringEventId'>;

type ServiceAccountKey = { client_email: string; private_key: string; token_uri?: string };

/** A Google API failure with its HTTP status; the message never contains credentials. */
export class GoogleCalendarError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

async function readGoogleError(response: Response): Promise<GoogleCalendarError> {
  let detail = '';
  try {
    const body = await response.json() as { error?: { message?: string } | string; error_description?: string };
    detail = typeof body.error === 'string'
      ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
      : body.error?.message ?? '';
  } catch {
    // Not JSON — the status alone has to do.
  }
  return new GoogleCalendarError(`Google ответил ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`, response.status);
}

/**
 * Creates a minimal Google Calendar v3 client authorised as a service account
 * (JWT bearer grant, no external packages). The key file is read on the first
 * request; the private key and tokens are never logged or returned.
 */
export function createGoogleCalendarClient(options: { credentialsPath: string; calendarId: string; fetch?: FetchLike }) {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const calendarPath = `${API_BASE}/calendars/${encodeURIComponent(options.calendarId)}`;
  let key: ServiceAccountKey | null = null;
  let token: { value: string; expiresAtMs: number } | null = null;

  const loadKey = async (): Promise<ServiceAccountKey> => {
    if (key) return key;
    let parsed: Partial<ServiceAccountKey>;
    try {
      parsed = JSON.parse(await readFile(options.credentialsPath, 'utf8')) as Partial<ServiceAccountKey>;
    } catch {
      throw new GoogleCalendarError('Не читается файл ключа сервисного аккаунта Google.', 0);
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new GoogleCalendarError('В файле ключа Google нет client_email или private_key.', 0);
    }
    key = { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
    return key;
  };

  const accessToken = async (): Promise<string> => {
    if (token && token.expiresAtMs - TOKEN_SKEW_MS > Date.now()) return token.value;
    const account = await loadKey();
    const nowSec = Math.floor(Date.now() / 1000);
    const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url');
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await readGoogleError(response);
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GoogleCalendarError('Google не выдал токен доступа.', response.status);
    token = { value: body.access_token, expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  };

  const request = async <T>(method: string, url: string, init: { body?: unknown; ifMatch?: string } = {}): Promise<T | null> => {
    const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.ifMatch) headers['if-match'] = init.ifMatch;
    const response = await fetchImpl(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) token = null;
    if (!response.ok) throw await readGoogleError(response);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) as T : null;
  };

  return {
    calendarId: options.calendarId,

    async getCalendar(): Promise<{ summary: string | null; timeZone: string | null }> {
      const body = await request<{ summary?: string; timeZone?: string }>('GET', calendarPath);
      return { summary: body?.summary ?? null, timeZone: body?.timeZone ?? null };
    },

    /**
     * One page of `events.list`. With `syncToken` it returns changes since the
     * token (a 410 means the token expired: do a full sync); without it, a full
     * listing from `timeMin` with instances of recurring events expanded.
     */
    async listEvents(query: { syncToken?: string | null; timeMin?: string; pageToken?: string | null }): Promise<{
      items: GoogleCalendarEvent[];
      nextPageToken: string | null;
      nextSyncToken: string | null;
    }> {
      const url = new URL(`${calendarPath}/events`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('showDeleted', 'true');
      if (query.syncToken) url.searchParams.set('syncToken', query.syncToken);
      else if (query.timeMin) url.searchParams.set('timeMin', query.timeMin);
      if (query.pageToken) url.searchParams.set('pageToken', query.pageToken);
      const body = await request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>('GET', url.toString());
      return {
        items: body?.items ?? [],
        nextPageToken: body?.nextPageToken ?? null,
        nextSyncToken: body?.nextSyncToken ?? null,
      };
    },

    /**
     * The live Google copy of a panel event, found by its
     * `extendedProperties.private.miragePanel` mark — used before an insert so
     * a push interrupted after Google accepted it never creates a duplicate.
     */
    async findEventByPanelId(panelEventId: string): Promise<GoogleCalendarEvent | null> {
      const url = new URL(`${calendarPath}/events`);
      url.searchParams.set('privateExtendedProperty', `miragePanel=${panelEventId}`);
      url.searchParams.set('maxResults', '5');
      const body = await request<{ items?: GoogleCalendarEvent[] }>('GET', url.toString());
      return (body?.items ?? []).find((item) => item.status !== 'cancelled'
        && item.extendedProperties?.private?.miragePanel === panelEventId) ?? null;
    },

    /** Reads one event; null when Google no longer has it (404 / 410). */
    async getEvent(eventId: string): Promise<GoogleCalendarEvent | null> {
      try {
        return await request<GoogleCalendarEvent>('GET', `${calendarPath}/events/${encodeURIComponent(eventId)}`);
      } catch (error) {
        if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) return null;
        throw error;
      }
    },

    async insertEvent(body: GoogleCalendarEventBody): Promise<GoogleCalendarEvent> {
      const created = await request<GoogleCalendarEvent>('POST', `${calendarPath}/events`, { body });
      if (!created?.id) throw new GoogleCalendarError('Google не вернул созданное событие.', 0);
      return created;
    },

    /** Patches an event; `etag` makes Google refuse (412) if it changed since it was read. */
    async patchEvent(eventId: string, body: Partial<GoogleCalendarEventBody>, etag?: string): Promise<GoogleCalendarEvent> {
      const patched = await request<GoogleCalendarEvent>('PATCH', `${calendarPath}/events/${encodeURIComponent(eventId)}`, { body, ifMatch: etag });
      if (!patched?.id) throw new GoogleCalendarError('Google не вернул изменённое событие.', 0);
      return patched;
    },

    /** Deletes an event; already-gone events (404 / 410) count as deleted. */
    async deleteEvent(eventId: string, etag?: string): Promise<void> {
      try {
        await request<null>('DELETE', `${calendarPath}/events/${encodeURIComponent(eventId)}`, { ifMatch: etag });
      } catch (error) {
        if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) return;
        throw error;
      }
    },
  };
}

/** The client the Google sync talks to; tests pass a fake with the same shape. */
export type GoogleCalendarClient = ReturnType<typeof createGoogleCalendarClient>;
