import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError, authenticatedFetch, readApiJson } from '@/shared/api';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const failure = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected readApiJson to reject');
    },
    (error: unknown) => error,
  );

describe('readApiJson', () => {
  it('resolves the payload for successful envelopes', async () => {
    const data = await readApiJson<{ data: { ok: boolean } }>(
      jsonResponse({ success: true, data: { ok: true } }),
    );
    expect(data.data.ok).toBe(true);
  });

  it('throws an ApiRequestError carrying code/details/status for the structured AppError envelope', async () => {
    const error = await failure(
      readApiJson(
        jsonResponse(
          {
            success: false,
            error: { code: 'BROWSER_USE_SESSION_STOP_FAILED', message: 'Failed to stop.', details: 'inner detail' },
          },
          400,
        ),
      ),
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    const apiError = error as ApiRequestError;
    expect(apiError.message).toBe('Failed to stop.');
    expect(apiError.code).toBe('BROWSER_USE_SESSION_STOP_FAILED');
    expect(apiError.details).toBe('inner detail');
    expect(apiError.status).toBe(400);
  });

  it('preserves top-level details on legacy string envelopes', async () => {
    const error = await failure(
      readApiJson(jsonResponse({ success: false, error: 'boom', details: 'legacy detail' }, 500)),
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    const apiError = error as ApiRequestError;
    expect(apiError.message).toBe('boom');
    expect(apiError.details).toBe('legacy detail');
    expect(apiError.code).toBeUndefined();
    expect(apiError.status).toBe(500);
  });

  it('uses the HTTP status in Russian when the envelope has neither error nor details', async () => {
    const error = await failure(readApiJson(jsonResponse({ success: false }, 502)));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toBe('Сервер ответил ошибкой (502)');
    expect((error as ApiRequestError).code).toBeUndefined();
  });

  it('a non-JSON error page (proxy 502) is a Russian ApiRequestError, not a SyntaxError', async () => {
    const error = await failure(readApiJson(new Response('<html>Bad Gateway</html>', { status: 502 })));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toBe('Сервер ответил ошибкой (502)');
  });
});

describe('authenticatedFetch', () => {
  it('a network failure reads «Нет связи с сервером», still a TypeError', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    try {
      const error = await failure(authenticatedFetch('/api/home/overview'));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toBe('Нет связи с сервером');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
