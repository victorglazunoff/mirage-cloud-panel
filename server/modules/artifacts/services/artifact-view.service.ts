import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ArtifactStoredManifest } from '@/shared/types.js';

/** Script hosts Artifacts may load from (the Artifact tool's own allow-list). */
const SCRIPT_HOSTS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com',
];
const STYLE_HOSTS = ['https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];
const FONT_HOSTS = ['https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];

/**
 * Used by the Artifacts routes on every frame response: the Content Security
 * Policy an Artifact page runs under.
 *
 * `sandbox allow-scripts allow-popups` (no `allow-same-origin`) puts the page
 * in an opaque origin even when it is opened outside the iframe, so it can
 * reach neither the panel's storage nor its token. Scripts only inline or from
 * the tool's CDN list, styles also from Google Fonts, images and media from
 * anywhere over https; no forms, no `<base>`, no plugins, and only the panel
 * itself may frame it.
 */
export const ARTIFACT_FRAME_CSP = [
  'sandbox allow-scripts allow-popups',
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${SCRIPT_HOSTS.join(' ')}`,
  `style-src 'self' 'unsafe-inline' ${STYLE_HOSTS.join(' ')}`,
  `font-src 'self' data: ${FONT_HOSTS.join(' ')}`,
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  `connect-src 'self' ${SCRIPT_HOSTS.join(' ')}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * Used by the Artifacts routes: headers of one frame response. The entry
 * document carries the ticket in its URL, so it is never cached or sent as a
 * referrer; supporting files may be cached privately for the ticket's life.
 */
export function buildArtifactFrameHeaders(isDocument: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': ARTIFACT_FRAME_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': isDocument ? 'no-store' : 'private, max-age=3600',
  };
}

/**
 * Runs before the Artifact's own scripts. `localStorage`/`sessionStorage`
 * throw in an opaque origin, so each is replaced by an in-memory store (the
 * page works, nothing is kept). `window.claude` — the claude.ai runtime (db,
 * ask, shared state, files, viewer) — does not exist here: every call returns a
 * promise rejected with a "not available in the panel" error instead of a
 * TypeError, and the parent panel is told through `postMessage` so it can show
 * an "interactive on claude.ai only" note.
 */
const ARTIFACT_SHIM = `<script>(function(){
var MSG='Недоступно в панели Mirage: эта функция артефакта работает только на claude.ai';
function tell(type,detail){try{parent.postMessage({source:'mirage-artifact',type:type,detail:detail},'*');}catch(e){}}
function memoryStorage(){var d=Object.create(null);return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;},setItem:function(k,v){d[String(k)]=String(v);},removeItem:function(k){delete d[String(k)];},clear:function(){d=Object.create(null);},key:function(i){var k=Object.keys(d);return i<k.length?k[i]:null;},get length(){return Object.keys(d).length;}};}
['localStorage','sessionStorage'].forEach(function(name){var ok=false;try{var s=window[name];s.setItem('__mirage','1');s.removeItem('__mirage');ok=true;}catch(e){}if(!ok){try{Object.defineProperty(window,name,{value:memoryStorage(),configurable:true});}catch(e){}}});
if(typeof window.claude==='undefined'){
var stub=function(path){var fn=function(){tell('claude-api-unavailable',path);return Promise.reject(new Error(MSG));};return new Proxy(fn,{get:function(t,p){if(p==='then'||typeof p==='symbol')return undefined;if(p==='available')return false;if(p==='toString')return function(){return '[Mirage: '+path+' недоступно]';};return stub(path+'.'+String(p));},apply:function(){tell('claude-api-unavailable',path);return Promise.reject(new Error(MSG));}});};
try{Object.defineProperty(window,'claude',{value:stub('claude'),configurable:true,writable:true});}catch(e){}
}
tell('ready',null);
})();</script>`;

/**
 * The skeleton claude.ai wraps a published page in. Artifact pages are written
 * as fragments (`<title>`, `<style>`, markup — no doctype), so without it the
 * browser would render them in quirks mode. No `<head>`/`<body>` tags: the
 * parser puts the fragment's title, links and styles into the head itself.
 */
const DOCUMENT_SKELETON = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';

/**
 * Used by the Artifacts service for HTML pages: makes the shim the first thing
 * the page runs. A full document gets it right after `<head>` (or `<html>`, or
 * the doctype) — never before the doctype, which would mean quirks mode; a
 * fragment is wrapped in the same skeleton claude.ai gives it.
 */
export function injectArtifactShim(html: string): string {
  const source = html.replace(/^﻿/, '');
  if (!/^\s*(<!--[\s\S]*?-->\s*)*<!doctype/i.test(source)) {
    return `${DOCUMENT_SKELETON}${ARTIFACT_SHIM}${source}`;
  }
  for (const pattern of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(source);
    if (match) {
      const insertAt = match.index + match[0].length;
      return `${source.slice(0, insertAt)}${ARTIFACT_SHIM}${source.slice(insertAt)}`;
    }
  }
  return `${DOCUMENT_SKELETON}${ARTIFACT_SHIM}${source}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only claude.ai links are ever rendered as "Open on claude.ai". */
function safeClaudeUrl(url: string): string | null {
  return /^https:\/\/claude\.ai\/[A-Za-z0-9/_.-]+$/.test(url) ? url : null;
}

const CARD_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141312;color:#E9E4DC;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:520px;border:1px solid #2C2925;border-radius:12px;padding:24px;background:#1A1917}
.kicker{font:600 11px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#9A9288}
h1{font-size:20px;margin:10px 0 6px}p{margin:0 0 14px;color:#B9B1A6}
ul{margin:0 0 18px;padding:0;list-style:none;display:grid;gap:6px}li{padding:8px 10px;border:1px solid #2C2925;border-radius:8px;font-family:ui-monospace,monospace;font-size:13px}
a.btn{display:inline-block;padding:10px 16px;border-radius:8px;background:#E08A3C;color:#141312;text-decoration:none;font-weight:600}`;

/**
 * Used by the Artifacts service when a version cannot be shown as a page: a
 * typed Artifact (Design canvas and other claude.ai types render with the
 * type's own runtime, which lives on claude.ai), or a page whose local copy is
 * gone. Lists the screens (`*.dc.html`) and links to claude.ai in a new tab —
 * claude.ai itself refuses to be framed (`frame-ancestors`).
 */
export function renderArtifactCard(manifest: ArtifactStoredManifest): string {
  const screens = manifest.ownFiles
    .filter((file) => file.endsWith('.dc.html'))
    .map((file) => file.replace(/^.*\//, '').replace(/\.dc\.html$/, ''));
  const url = safeClaudeUrl(manifest.url);
  const version = manifest.seq !== null ? `версия ${manifest.seq}` : manifest.version;
  const explanation = manifest.kind === 'typed'
    ? 'Это артефакт типа claude.ai (например, холст Design). Его страница собирается рантаймом типа на claude.ai, поэтому в панели показан только состав.'
    : 'Локальная копия этой версии не сохранилась (файл удалён до того, как панель его скопировала).';

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(manifest.title)}</title><style>${CARD_STYLE}</style></head><body><main class="card">
<div class="kicker">Артефакт · ${escapeHtml(version)}</div>
<h1>${escapeHtml(manifest.title)}</h1>
<p>${explanation}</p>
${screens.length > 0 ? `<div class="kicker" style="margin-bottom:8px">Экраны · ${screens.length}</div><ul>${screens.map((screen) => `<li>${escapeHtml(screen)}</li>`).join('')}</ul>` : ''}
${url ? `<a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Открыть на claude.ai</a>` : ''}
</main></body></html>`;
}

/**
 * Used by the Artifacts service for `.md` Artifacts: a page that renders the
 * Markdown with `marked` from cdnjs (allowed by the frame CSP) and falls back
 * to plain text when the CDN is unreachable. The source is embedded as JSON
 * with `<` escaped, so it cannot close the script element.
 */
export function renderMarkdownArtifact(title: string, markdown: string): string {
  const source = JSON.stringify(markdown).replace(/</g, '\\u003c');
  return injectArtifactShim(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0 auto;max-width:760px;padding:24px 16px;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:4px 8px}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
</head><body><main id="doc"></main>
<script type="application/json" id="source">${source}</script>
<script>(function(){var md=JSON.parse(document.getElementById('source').textContent);var root=document.getElementById('doc');
if(window.marked&&typeof window.marked.parse==='function'){root.innerHTML=window.marked.parse(md);}else{var pre=document.createElement('pre');pre.textContent=md;root.appendChild(pre);}})();</script>
</body></html>`);
}

/** What a frame ticket grants: one stored version of one Artifact until `expiresAt` (epoch seconds). */
type ArtifactTicketPayload = {
  artifactId: string;
  versionDir: string;
  expiresAt: number;
};

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Used by the Artifacts service: a ticket for the frame URL, signed with a
 * per-process secret (tickets die with a restart). It grants exactly one
 * stored version of one Artifact, so if the untrusted page reads its own URL
 * it learns nothing it could not already see.
 */
export function createArtifactTicket(payload: ArtifactTicketPayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify([payload.artifactId, payload.versionDir, payload.expiresAt]), 'utf8')
    .toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Used by the Artifacts service: the payload of a valid, unexpired ticket for
 * `artifactId`, or `null`.
 */
export function verifyArtifactTicket(
  ticket: string,
  artifactId: string,
  secret: Buffer,
  nowSeconds: number,
): ArtifactTicketPayload | null {
  const [encoded, signature, extra] = ticket.split('.');
  if (!encoded || !signature || extra !== undefined) {
    return null;
  }

  const expected = Buffer.from(sign(encoded, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const [ticketArtifactId, versionDir, expiresAt] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as [
      unknown,
      unknown,
      unknown,
    ];
    if (
      ticketArtifactId !== artifactId
      || typeof versionDir !== 'string'
      || typeof expiresAt !== 'number'
      || expiresAt < nowSeconds
    ) {
      return null;
    }
    return { artifactId, versionDir, expiresAt };
  } catch {
    return null;
  }
}
