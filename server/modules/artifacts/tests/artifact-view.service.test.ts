import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  ARTIFACT_FRAME_CSP,
  buildArtifactFrameHeaders,
  createArtifactTicket,
  injectArtifactShim,
  renderArtifactCard,
  renderMarkdownArtifact,
  verifyArtifactTicket,
} from '@/modules/artifacts/services/artifact-view.service.js';
import type { ArtifactStoredManifest } from '@/shared/types.js';

function directives(csp: string): Map<string, string> {
  return new Map(csp.split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values.join(' ')];
  }));
}

test('the frame CSP sandboxes the page without same-origin and lets only the panel frame it', () => {
  const policy = directives(ARTIFACT_FRAME_CSP);
  assert.equal(policy.get('sandbox'), 'allow-scripts allow-popups');
  assert.ok(!ARTIFACT_FRAME_CSP.includes('allow-same-origin'));
  assert.ok(!ARTIFACT_FRAME_CSP.includes('allow-top-navigation'));
  assert.equal(policy.get('frame-ancestors'), "'self'");
  assert.equal(policy.get('default-src'), "'none'");
  assert.equal(policy.get('form-action'), "'none'");
  assert.equal(policy.get('base-uri'), "'none'");
  for (const host of ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com']) {
    assert.ok(policy.get('script-src')?.includes(host), `${host} scripts`);
  }
  assert.ok(policy.get('style-src')?.includes('https://fonts.googleapis.com'));
  assert.ok(policy.get('font-src')?.includes('https://fonts.gstatic.com'));
  // Scripts come from the listed CDNs only, never from any https host.
  assert.ok(!/(^|\s)https:(\s|$)/.test(policy.get('script-src') ?? ''));
});

test('frame headers forbid sniffing and keep the ticketed document out of caches', () => {
  const documentHeaders = buildArtifactFrameHeaders(true);
  assert.equal(documentHeaders['Content-Security-Policy'], ARTIFACT_FRAME_CSP);
  assert.equal(documentHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(documentHeaders['Referrer-Policy'], 'no-referrer');
  assert.equal(documentHeaders['Cache-Control'], 'no-store');
  assert.equal(buildArtifactFrameHeaders(false)['Cache-Control'], 'private, max-age=3600');
});

test('the shim runs first: after <head>, never before the doctype', () => {
  const page = '<!DOCTYPE html><html lang="ru"><head><title>x</title></head><body></body></html>';
  const injected = injectArtifactShim(page);
  assert.ok(injected.startsWith('<!DOCTYPE html><html lang="ru"><head><script>'));
  assert.ok(injected.includes("window.claude"));
  assert.ok(injected.includes('localStorage'));
  assert.ok(injected.indexOf('<script>') < injected.indexOf('<title>'));

  assert.ok(injectArtifactShim('<!doctype html><p>no head</p>').startsWith('<!doctype html><script>'));
});

test('a fragment page gets the doctype skeleton claude.ai wraps it in, then the shim', () => {
  const injected = injectArtifactShim('﻿<title>План</title>\n<style>p{}</style><p>x</p>');
  assert.ok(injected.startsWith('<!doctype html><meta charset="utf-8"><meta name="viewport"'));
  assert.ok(injected.indexOf('<script>') < injected.indexOf('<title>План</title>'));
  assert.ok(!injected.includes('﻿'));
});

test('a ticket opens one version of one artifact until it expires', () => {
  const secret = randomBytes(32);
  const ticket = createArtifactTicket({ artifactId: 'art-1', versionDir: '1792-abcd', expiresAt: 1000 }, secret);

  assert.deepEqual(verifyArtifactTicket(ticket, 'art-1', secret, 999), {
    artifactId: 'art-1',
    versionDir: '1792-abcd',
    expiresAt: 1000,
  });
  assert.equal(verifyArtifactTicket(ticket, 'art-1', secret, 1001), null, 'expired');
  assert.equal(verifyArtifactTicket(ticket, 'art-2', secret, 999), null, 'another artifact');
  assert.equal(verifyArtifactTicket(ticket, 'art-1', randomBytes(32), 999), null, 'another secret');

  const [payload, signature] = ticket.split('.');
  const forged = Buffer.from(JSON.stringify(['art-1', '../../etc', 1000])).toString('base64url');
  assert.equal(verifyArtifactTicket(`${forged}.${signature}`, 'art-1', secret, 999), null, 'tampered payload');
  assert.equal(verifyArtifactTicket(`${payload}.${signature}.x`, 'art-1', secret, 999), null);
});

test('the typed card escapes the title, lists screens and links only to claude.ai', () => {
  const manifest: ArtifactStoredManifest = {
    artifactId: 'art-1',
    versionDir: 'v',
    version: 'v',
    seq: 4,
    kind: 'typed',
    title: '<img src=x onerror=alert(1)>',
    url: 'https://claude.ai/artifact/X5y',
    icon: null,
    label: null,
    publishedAt: null,
    entryPath: null,
    files: [],
    skipped: [],
    ownFiles: ['project/Main.dc.html', 'project/Phone.dc.html', 'project/canvas.json'],
    capturedAt: '',
    origin: 'live',
    modifiedAfterPublish: false,
  };

  const card = renderArtifactCard(manifest);
  assert.ok(!card.includes('<img src=x'));
  assert.ok(card.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(card.includes('<li>Main</li>') && card.includes('<li>Phone</li>'));
  assert.ok(card.includes('href="https://claude.ai/artifact/X5y" target="_blank"'));
  assert.ok(card.includes('версия 4'));

  const hostile = renderArtifactCard({ ...manifest, url: 'javascript:alert(1)' });
  assert.ok(!hostile.includes('javascript:'));
});

test('markdown is embedded as JSON that cannot close its script element', () => {
  const page = renderMarkdownArtifact('Заметки', '# Hi\n</script><script>alert(1)</script>');
  assert.ok(!page.includes('</script><script>alert(1)'));
  assert.ok(page.includes('\\u003c/script>'));
  assert.ok(page.includes('cdnjs.cloudflare.com/ajax/libs/marked/'));
});
