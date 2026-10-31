import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { createArtifactsRouter, createSessionArtifactsRouter } from '@/modules/artifacts/artifacts.routes.js';
import { ARTIFACT_FRAME_CSP } from '@/modules/artifacts/services/artifact-view.service.js';
import type { ArtifactsRouteServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const TICKET = 'eyJhIjoxfQ.abcdefghijklmnopqrstuvwxyz012345';

function createFakeServices(overrides: Partial<ArtifactsRouteServices> = {}): ArtifactsRouteServices {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected Artifacts service call');
  };
  return {
    listSessionArtifacts: unexpected,
    createViewTicket: unexpected,
    renderFrame: unexpected,
    ...overrides,
  };
}

/** Accepts only `Authorization: Bearer good`, like the panel's token check. */
const fakeAuthenticate: RequestHandler = (request, response, next) => {
  if (request.headers.authorization === 'Bearer good' || request.query.token === 'good') {
    next();
    return;
  }
  response.status(401).json({ error: 'Access denied' });
};

async function withServer(services: ArtifactsRouteServices, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api/sessions', fakeAuthenticate, createSessionArtifactsRouter(services));
  app.use('/api/artifacts', createArtifactsRouter(services, fakeAuthenticate));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: String(error) });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('the session list needs the panel token and 404s for an unknown session', async () => {
  const asked: string[] = [];
  const services = createFakeServices({
    listSessionArtifacts: async (sessionId) => {
      asked.push(sessionId);
      return sessionId === 'known' ? { sessionId, artifacts: [] } : null;
    },
  });

  await withServer(services, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/sessions/known/artifacts`)).status, 401);

    const ok = await fetch(`${baseUrl}/api/sessions/known/artifacts`, { headers: { Authorization: 'Bearer good' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { sessionId: 'known', artifacts: [] });

    const missing = await fetch(`${baseUrl}/api/sessions/other/artifacts`, { headers: { Authorization: 'Bearer good' } });
    assert.equal(missing.status, 404);

    const invalid = await fetch(`${baseUrl}/api/sessions/bad%20id/artifacts`, { headers: { Authorization: 'Bearer good' } });
    assert.equal(invalid.status, 400);
  });
  assert.deepEqual(asked, ['known', 'other']);
});

test('view needs the token, then answers with the frame URL or redirects to it', async () => {
  const inputs: unknown[] = [];
  const services = createFakeServices({
    createViewTicket: async (input) => {
      inputs.push(input);
      return {
        url: `/api/artifacts/${input.artifactId}/frame/${TICKET}/`,
        artifactId: input.artifactId,
        version: '1792-abcd',
        seq: 2,
        kind: 'page',
        expiresAt: '2026-10-26T12:00:00.000Z',
      };
    },
  });

  await withServer(services, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/artifacts/art-1/view`)).status, 401);

    const json = await fetch(`${baseUrl}/api/artifacts/art-1/view?format=json&version=2`, {
      headers: { Authorization: 'Bearer good' },
    });
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('cache-control'), 'no-store');
    assert.equal((await json.json() as { url: string }).url, `/api/artifacts/art-1/frame/${TICKET}/`);

    const redirect = await fetch(`${baseUrl}/api/artifacts/art-1/view?token=good&sessionId=s-1`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), `/api/artifacts/art-1/frame/${TICKET}/`);

    const badVersion = await fetch(`${baseUrl}/api/artifacts/art-1/view?version=../x`, {
      headers: { Authorization: 'Bearer good' },
    });
    assert.equal(badVersion.status, 400);
  });

  assert.deepEqual(inputs, [
    { artifactId: 'art-1', version: '2', sessionId: null },
    { artifactId: 'art-1', version: null, sessionId: 's-1' },
  ]);
});

test('the frame is served with the sandboxing CSP and nosniff, without the panel token', async () => {
  const inputs: unknown[] = [];
  const services = createFakeServices({
    renderFrame: async (input) => {
      inputs.push(input);
      if (input.filePath === '') {
        return { body: Buffer.from('<html>ok</html>'), contentType: 'text/html; charset=utf-8', isDocument: true };
      }
      if (input.filePath === 'img/a b.svg') {
        return { body: Buffer.from('<svg/>'), contentType: 'image/svg+xml', isDocument: false };
      }
      return null;
    },
  });

  await withServer(services, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/api/artifacts/art-1/frame/${TICKET}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), ARTIFACT_FRAME_CSP);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(await page.text(), '<html>ok</html>');

    const image = await fetch(`${baseUrl}/api/artifacts/art-1/frame/${TICKET}/img/a%20b.svg`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-security-policy'), ARTIFACT_FRAME_CSP);
    assert.match(image.headers.get('content-type') ?? '', /^image\/svg\+xml/);

    assert.equal((await fetch(`${baseUrl}/api/artifacts/art-1/frame/${TICKET}/nope.js`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/artifacts/art-1/frame/not-a-ticket/`)).status, 400);

    const noSlash = await fetch(`${baseUrl}/api/artifacts/art-1/frame/${TICKET}`, { redirect: 'manual' });
    assert.equal(noSlash.status, 302);
    assert.equal(noSlash.headers.get('location'), `/api/artifacts/art-1/frame/${TICKET}/`);
  });

  assert.deepEqual(inputs, [
    { artifactId: 'art-1', ticket: TICKET, filePath: '' },
    { artifactId: 'art-1', ticket: TICKET, filePath: 'img/a b.svg' },
    { artifactId: 'art-1', ticket: TICKET, filePath: 'nope.js' },
  ]);
});
