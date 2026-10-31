import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { ChevronDown, ChevronRight, DocIcon } from '@/modules/kabina-chat/ChatIcons';
import { formatPercent, formatTokens } from '@/modules/kabina-chat/utils/chatFormat';
import type { SessionContextCategory, SessionContextUsage } from '@/shared/types';

const HATCH = 'repeating-linear-gradient(135deg, #8C857A 0 2px, #2A2723 2px 4px)';

/** Mock-up colour and Russian name per SDK category id; the order is the mock-up's. */
const CATEGORY_STYLE: Array<{ match: RegExp; label: string; bg: string }> = [
  { match: /^messages?$/, label: 'Сообщения', bg: '#FF6A2B' },
  { match: /mcp/, label: 'MCP-инструменты', bg: '#D9A35B' },
  { match: /system_tools|^tools$/, label: 'Системные инструменты', bg: '#7FA8C9' },
  { match: /system_prompt|^prompt$/, label: 'Системный промпт', bg: '#9CC49A' },
  { match: /skill/, label: 'Скиллы', bg: '#CFC6B6' },
  { match: /memory/, label: 'Память · CLAUDE.md', bg: '#B79A7A' },
  { match: /agent/, label: 'Агенты', bg: '#8FB3A3' },
  { match: /autocompact|buffer/, label: 'Буфер автосжатия', bg: HATCH },
  { match: /free/, label: 'Свободно', bg: '#12110F' },
];

type StyledCategory = SessionContextCategory & { label: string; bg: string; order: number };

function styleCategories(categories: SessionContextCategory[]): StyledCategory[] {
  return categories
    .filter((category) => category.kind !== 'deferred' && (category.tokens > 0 || category.kind === 'free'))
    .map((category) => {
      const index = CATEGORY_STYLE.findIndex((style) => style.match.test(category.id));
      const style = CATEGORY_STYLE[index];
      return {
        ...category,
        label: style?.label ?? category.name,
        bg: style?.bg ?? '#6F685E',
        order: index === -1 ? CATEGORY_STYLE.length - 2.5 : index,
      };
    })
    .sort((a, b) => a.order - b.order);
}

function fillNote(percentage: number, estimated: boolean): string {
  const note = percentage < 40 ? 'занято · запас большой'
    : percentage < 70 ? 'занято · запас есть'
      : percentage < 85 ? 'занято · скоро сжатие'
        : 'занято · сожмётся на этом ходе';
  return estimated ? `${note} · оценка` : note;
}

type ContextPanelProps = {
  usage: SessionContextUsage | null;
  error: string | null;
  hasSession: boolean;
  variant: 'aside' | 'sheet';
  /** «Opus · 1M · high» for the СЕССИЯ block. */
  modelLine: { name: string; meta: string };
  onOpenFile: (path: string) => void;
  /** Phone sheet only: the permission and model blocks of DarkPhoneChat. */
  extra?: ReactNode;
  /** «769k до автосжатия · Сжать сессию» row (desktop; the sheet pins it in its footer). */
  compact?: ReactNode;
  /** A turn is running: the cost arrives with its end, not «нет живого хода». */
  isRunning?: boolean;
};

/**
 * Rendered by the kabina-chat screen as the right column «Контекст» and, on
 * the phone, as the body of the context sheet: window fill with the category
 * bar and compaction mark, the expandable MCP / skill rows, session cost and
 * tokens, and the files the conversation read.
 */
export function ContextPanel({ usage, error, hasSession, variant, modelLine, onOpenFile, extra, compact, isRunning = false }: ContextPanelProps) {
  // Whether the category table under the gauge is unfolded («КОНТЕКСТ ▾»).
  const [expanded, setExpanded] = useState(true);
  // Categories whose items (MCP servers, skills) are unfolded.
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const isSheet = variant === 'sheet';

  if (!hasSession || !usage) {
    const note = !hasSession
      ? <p className="kbc-empty">Контекст появится, когда в диалоге будет первое сообщение.</p>
      : <p className="kbc-empty kb-m">{error ? `Контекст: ${error}` : 'считаю контекст…'}</p>;
    return isSheet ? <div className="kbc-sheet-body">{note}{extra}</div> : note;
  }

  const categories = styleCategories(usage.categories);
  const max = usage.maxTokens || 1;
  const percent = Math.round(usage.percentage);
  const markLeft = usage.autoCompactThreshold ? Math.min(100, (usage.autoCompactThreshold / max) * 100) : null;
  const buffer = categories.find((category) => /autocompact|buffer/.test(category.id));
  const ariaLabel = `Занято ${formatTokens(usage.totalTokens)} токенов из ${formatTokens(max)}${buffer ? `, буфер автосжатия ${formatTokens(buffer.tokens)}` : ''}`;

  const gauge = (
    <>
      <div className="kbc-big">
        <span className="kbc-big-n kb-t">{percent}<span>%</span></span>
        <span className="kbc-big-note">{fillNote(usage.percentage, usage.estimated)}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div role="img" aria-label={ariaLabel} className="kbc-bar">
          {categories.filter((category) => category.kind !== 'free').map((category) => (
            <span key={category.id} style={{ width: `${Math.max(0.4, (category.tokens / max) * 100)}%`, background: category.bg }} />
          ))}
        </div>
        <div className="kbc-scale" aria-hidden="true">
          {markLeft !== null && <span className="kbc-scale-mark" style={{ left: `${markLeft}%` }} />}
        </div>
        <div className="kbc-scale-labels kb-m" aria-hidden="true">
          <span>0</span>
          <span>{formatTokens(max / 4)}</span>
          <span>{formatTokens(max / 2)}</span>
          <span>{formatTokens((max * 3) / 4)}</span>
          <span>сжатие ▴ {formatTokens(max)}</span>
        </div>
      </div>
    </>
  );

  const rows = (
    <div className="kbc-crows kb-fadein">
      {categories.map((category) => {
        const swatch: CSSProperties = {
          background: category.bg,
          boxShadow: category.kind === 'free' ? 'inset 0 0 0 1px rgba(255,236,210,0.28)' : undefined,
        };
        const tokens = <span className="kbc-num kb-m">{formatTokens(category.tokens)}</span>;
        const pct = <span className="kbc-num kb-m" data-strong="">{formatPercent(category.percentage)}</span>;
        if (category.items.length > 0) {
          const isOpen = Boolean(openCats[category.id]);
          const top = category.items[0]?.tokens || 1;
          return (
            <div key={category.id} style={{ display: 'contents' }}>
              <button
                type="button"
                className="kbc-crow"
                aria-expanded={isOpen}
                onClick={() => setOpenCats((current) => ({ ...current, [category.id]: !isOpen }))}
              >
                <span className="kbc-swatch" aria-hidden="true" style={swatch} />
                <span className="kbc-crow-label">
                  <span>{category.label}</span>
                  <ChevronRight size={10} strokeWidth={2.4} className="kbc-chev" />
                </span>
                {tokens}
                {pct}
              </button>
              {isOpen && category.items.slice(0, 12).map((item) => (
                <div key={item.name} className="kbc-csub kb-fadein">
                  <span className="kbc-csub-name kb-m">{item.name}</span>
                  <span className="kbc-csub-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((item.tokens / top) * 100)}%`, background: category.bg }} />
                  </span>
                  <span className="kbc-num kb-m">{formatTokens(item.tokens)}</span>
                </div>
              ))}
            </div>
          );
        }
        return (
          <div key={category.id} className="kbc-crow">
            <span className="kbc-swatch" aria-hidden="true" style={swatch} />
            <span className="kbc-crow-label" style={category.kind === 'free' ? { color: 'var(--kb-soft)' } : undefined}>
              <span>{category.label}</span>
            </span>
            {tokens}
            {pct}
          </div>
        );
      })}
    </div>
  );

  const totals = usage.session;
  const inputTotal = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  const cacheHit = inputTotal > 0 ? Math.round((totals.cacheReadTokens / inputTotal) * 100) : null;
  const sessionBlock = (
    <section aria-label="Сессия" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h2 className="kbc-h kb-m" style={{ margin: '0 0 8px' }}>СЕССИЯ</h2>
      <dl className="kbc-dl">
        <dt>Стоимость</dt>
        <dd className="kb-m">
          {totals.costUsd !== null
            ? <>${totals.costUsd.toFixed(2)} <span>по API{isRunning ? ' · до этого хода' : ''}</span></>
            : <span>{isRunning ? 'посчитаю в конце хода' : 'нет живого хода'}</span>}
        </dd>
        <dt>Токены</dt>
        <dd className="kb-m">{formatTokens(inputTotal)} <span>вход</span> · {formatTokens(totals.outputTokens)} <span>выход</span></dd>
        <dt>Кэш</dt>
        <dd className="kb-m">{cacheHit !== null ? <>{cacheHit}% <span>попаданий</span></> : <span>—</span>}</dd>
        {!isSheet && (
          <>
            <dt>Модель</dt>
            <dd style={{ fontSize: 13 }}>{modelLine.name} <span className="kb-m" style={{ fontSize: 11 }}>· {modelLine.meta}</span></dd>
          </>
        )}
      </dl>
    </section>
  );

  const filesTotal = usage.files.reduce((sum, file) => sum + file.tokens, 0);
  const filesBlock = usage.files.length > 0 && (
    <section aria-label="Файлы в контексте" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 className="kbc-h kb-m">ФАЙЛЫ · {usage.files.length}</h2>
        <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>{formatTokens(filesTotal)}</span>
      </div>
      {usage.files.slice(0, 40).map((file) => (
        <button
          key={file.path}
          type="button"
          className="kbc-crow kbc-file"
          style={{ cursor: 'pointer', minHeight: 32 }}
          title={file.path}
          onClick={() => onOpenFile(file.path)}
        >
          <DocIcon size={13} strokeWidth={1.7} className="kbc-file-ico" />
          <span className="kbc-file-name kb-m"><span>{file.dir}</span>{file.name}</span>
          {file.tokens > 0 && (
            <span className="kb-m" style={{ flex: 'none', fontSize: 10.5, color: 'var(--kb-mute)' }}>{formatTokens(file.tokens)}</span>
          )}
        </button>
      ))}
    </section>
  );

  if (isSheet) {
    return (
      <div className="kbc-sheet-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {gauge}
          {rows}
        </div>
        {extra}
        {sessionBlock}
        {filesBlock}
      </div>
    );
  }

  return (
    <>
      <section aria-label="Контекст" className="kbc-sec">
        <div className="kbc-sec-head">
          <h2 style={{ margin: 0 }}>
            <button type="button" className="kbc-sec-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              <span className="kb-m" style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.2em' }}>КОНТЕКСТ</span>
              <ChevronDown size={12} className="kbc-chev" />
            </button>
          </h2>
          <span className="kbc-sub kb-m">{formatTokens(usage.totalTokens)} / {formatTokens(max)}</span>
        </div>
        {gauge}
        {expanded && rows}
        {compact}
      </section>
      {sessionBlock}
      {filesBlock}
    </>
  );
}

/** «769k до автосжатия» / «сожмётся после хода». */
export function compactText(usage: SessionContextUsage, isPhone: boolean): string {
  if (usage.compactQueued) return isPhone ? 'сожмётся после хода · ход не прервётся' : 'сожмётся после хода';
  const until = usage.tokensUntilAutoCompact;
  const base = until !== null ? `${formatTokens(until)} до автосжатия` : 'автосжатие по порогу CLI';
  return isPhone ? `${base} · ход не прервётся` : base;
}
