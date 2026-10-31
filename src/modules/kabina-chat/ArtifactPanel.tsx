import { useEffect, useRef, useState } from 'react';

import {
  CheckIcon,
  ChevronDown,
  CloseIcon,
  CollapseIcon,
  CommentIcon,
  ExpandIcon,
  LinkOutIcon,
  MicIcon,
  RefreshIcon,
  ShareIcon,
} from '@/modules/kabina-chat/ChatIcons';
import { useArtifactFrame } from '@/modules/kabina-chat/hooks/useSessionArtifacts';
import { formatClock } from '@/modules/kabina-chat/utils/chatFeed';
import type { ArtifactSummary } from '@/shared/types';

const KIND_LABEL: Record<ArtifactSummary['kind'], string> = { page: 'страница', markdown: 'документ', typed: 'claude.ai' };

function publishedTime(artifact: ArtifactSummary): string {
  return artifact.publishedAt ? formatClock(artifact.publishedAt) : '';
}

type ArtifactPanelProps = {
  artifacts: ArtifactSummary[];
  artifact: ArtifactSummary;
  sessionId: string | null;
  isPhone: boolean;
  isFull: boolean;
  onPick: (artifactId: string) => void;
  onToggleFull: () => void;
  onClose: () => void;
  /** Puts «К артефакту «…» (ссылка): » into the composer, so the remark reaches Claude with the place. */
  onComment: (artifact: ArtifactSummary) => void;
  onVoice: () => void;
};

/** Copies the claude.ai link; resolves whether it worked (the clipboard needs a secure context). */
async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = url;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  }
}

/**
 * Rendered by the kabina-chat screen in the right column (desktop) or over the
 * whole screen (phone): the open Artifact in `<iframe sandbox="allow-scripts">`
 * from the panel's ticketed frame, the session's artifact menu, «Обновить»,
 * «Поделиться» (copies the claude.ai link), «Открыть на claude.ai», full screen
 * and close.
 */
export default function ArtifactPanel({
  artifacts,
  artifact,
  sessionId,
  isPhone,
  isFull,
  onPick,
  onToggleFull,
  onClose,
  onComment,
  onVoice,
}: ArtifactPanelProps) {
  // Bumped by «Обновить» to ask for a fresh ticket and reload the frame.
  const [refreshKey, setRefreshKey] = useState(0);
  // The session's artifact menu under the title.
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // «Ссылка скопирована» for a moment after sharing.
  const [isShared, setIsShared] = useState(false);
  // Comment mode: the hint shows and the composer holds the artifact reference.
  const [isCommenting, setIsCommenting] = useState(false);
  // When the frame last (re)loaded, for «обновлено HH:MM».
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { ticket, error } = useArtifactFrame(
    artifact.kind === 'typed' ? null : artifact.artifactId,
    artifact.version,
    sessionId,
    refreshKey,
  );

  useEffect(() => {
    setIsCommenting(false);
    setIsShared(false);
    setLoadedAt(null);
  }, [artifact.artifactId]);

  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setIsMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [isMenuOpen]);

  const share = async () => {
    if (await copyLink(artifact.url)) {
      setIsShared(true);
      window.setTimeout(() => setIsShared(false), 2500);
    }
  };

  const toggleComment = () => {
    const next = !isCommenting;
    setIsCommenting(next);
    if (next) onComment(artifact);
  };

  const index = Math.max(0, artifacts.findIndex((item) => item.artifactId === artifact.artifactId));
  const updated = loadedAt ?? publishedTime(artifact);

  const menu = isMenuOpen && (
    <div ref={menuRef} role="menu" aria-label="Артефакты этой сессии" className="kbc-menu kbc-art-menu kb-fadein">
      <span className="kbc-pop-cap kb-m">АРТЕФАКТЫ СЕССИИ · {artifacts.length}</span>
      {artifacts.map((item) => {
        const current = item.artifactId === artifact.artifactId;
        return (
          <button
            key={item.artifactId}
            type="button"
            role="menuitem"
            aria-current={current}
            className="kbc-menu-item"
            data-active={current ? '' : undefined}
            style={current ? { background: 'rgba(255,106,43,0.14)' } : undefined}
            onClick={() => {
              setIsMenuOpen(false);
              onPick(item.artifactId);
            }}
          >
            <span className="kbc-art-menu-text">
              <span>{item.title}</span>
              <span className="kb-m">{KIND_LABEL[item.kind]} · {publishedTime(item)}{item.versionsCount > 1 ? ` · v${item.seq ?? item.versionsCount}` : ''}</span>
            </span>
            {current && <CheckIcon size={isPhone ? 15 : 14} />}
          </button>
        );
      })}
    </div>
  );

  const commentHint = isCommenting && (
    <div className="kbc-comment-hint kb-fadein">
      <CommentIcon size={14} strokeWidth={1.8} />
      <span>Напиши замечание в поле сообщения — оно уйдёт Claude вместе со ссылкой на этот артефакт.</span>
    </div>
  );

  const frame = artifact.kind === 'typed' ? (
    <div className="kbc-sec" style={{ gap: 10 }}>
      <p className="kbc-empty">Этот артефакт собран из типа claude.ai ({artifact.label || 'дизайн, слайды или документ'}) — его страница живёт только там.</p>
      {artifact.screens.length > 0 && (
        <ul className="kbc-screens kb-m">
          {artifact.screens.map((screen) => <li key={screen} style={{ fontSize: 11, color: 'var(--kb-soft)' }}>{screen}</li>)}
        </ul>
      )}
      <a className="kb-btn kb-pri" href={artifact.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }}>
        Открыть на claude.ai <LinkOutIcon size={14} />
      </a>
    </div>
  ) : error ? (
    <div className="kbc-sec" style={{ gap: 10 }}>
      <p className="kbc-empty">{error}</p>
      <a className="kb-btn kb-ghost" href={artifact.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }}>
        Открыть на claude.ai <LinkOutIcon size={14} />
      </a>
    </div>
  ) : (
    <iframe
      key={ticket?.url ?? 'loading'}
      title={artifact.title}
      className="kbc-art-frame"
      data-loading={ticket ? undefined : ''}
      sandbox="allow-scripts"
      src={ticket?.url}
      onLoad={() => ticket && setLoadedAt(formatClock(new Date()))}
    />
  );

  if (isPhone) {
    return (
      <section className="kb-root kbc-pfull" role="dialog" aria-modal="true" aria-label={`Артефакт «${artifact.title}»`}>
        <div className="kbc-pfull-bar">
          <button type="button" className="kbc-ib" style={{ width: 44, height: 44, color: 'var(--kb-text)' }} aria-label="Закрыть артефакт, вернуться в чат" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
          <button type="button" className="kbc-pfull-pick" aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((open) => !open)}>
            <span>
              <span className="kb-m">АРТЕФАКТ {index + 1} ИЗ {artifacts.length || 1}</span>
              <span>{artifact.title}</span>
            </span>
            <ChevronDown size={12} className="kbc-chev" />
          </button>
          <button
            type="button"
            className="kbc-ib"
            style={{ width: 44, height: 44, borderColor: 'var(--kb-line-mid)' }}
            aria-label="Обновить данные"
            onClick={() => setRefreshKey((key) => key + 1)}
          >
            <RefreshIcon size={17} />
          </button>
          {menu}
        </div>
        <div className="kbc-pfull-body">
          {commentHint}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h2 className="kbc-art-h kb-t">{artifact.title}</h2>
            <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>
              {KIND_LABEL[artifact.kind]}{updated ? ` · обновлено ${updated}` : ''} · <a className="kbc-hit-link" href={artifact.url} target="_blank" rel="noreferrer">claude.ai</a>
            </span>
          </div>
          {frame}
        </div>
        <div className="kbc-pfull-foot">
          <button
            type="button"
            className="kb-btn kb-ghost kbc-pfull-comment"
            aria-pressed={isCommenting}
            style={isCommenting ? { background: 'rgba(255,106,43,0.14)', color: 'var(--kb-signal-text)', borderColor: 'rgba(255,106,43,0.55)' } : undefined}
            onClick={toggleComment}
          >
            <CommentIcon size={16} strokeWidth={1.7} />
            <span>{isCommenting ? 'Комментирую' : 'Комментировать'}</span>
          </button>
          <button type="button" className="kb-btn kb-pri" onClick={() => void share()}>
            {isShared ? <CheckIcon size={16} /> : <ShareIcon size={16} />}
            <span>{isShared ? 'Скопировано' : 'Поделиться'}</span>
          </button>
          <span className="kbc-pvoice" style={{ width: 66, height: 66 }}>
            <svg className="kbc-ring" width="66" height="66" viewBox="0 0 66 66" aria-hidden="true">
              <circle cx="33" cy="33" r="31" fill="none" stroke="rgba(255,106,43,0.6)" strokeWidth="3" strokeDasharray="1 5.01" />
            </svg>
            <button type="button" style={{ width: 52, height: 52 }} onClick={onVoice} aria-label="Спросить про артефакт голосом">
              <MicIcon size={22} strokeWidth={1.8} />
            </button>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="kbc-art kbc-slidein kb-bz" aria-label={`Артефакт «${artifact.title}»`}>
      <div className="kbc-art-bar">
        <button type="button" className="kbc-art-pick" aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((open) => !open)}>
          <span>{artifact.title}</span>
          <ChevronDown size={12} className="kbc-chev" />
        </button>
        {menu}
        <div style={{ flex: '1 1 0' }} />
        <button
          type="button"
          className="kbc-ib kbc-art-ib"
          aria-pressed={isCommenting}
          aria-label="Комментировать артефакт"
          title="Комментировать"
          onClick={toggleComment}
        >
          <CommentIcon size={17} />
        </button>
        <button type="button" className="kbc-share" onClick={() => void share()} title="Скопировать ссылку claude.ai">
          {isShared ? <CheckIcon size={14} strokeWidth={2.2} /> : <ShareIcon size={14} />}
          <span>{isShared ? 'Ссылка скопирована' : 'Поделиться'}</span>
        </button>
        <a className="kbc-ib kbc-art-ib" href={artifact.url} target="_blank" rel="noreferrer" aria-label="Открыть на claude.ai" title="Открыть на claude.ai">
          <LinkOutIcon size={16} />
        </a>
        <button
          type="button"
          className="kbc-ib kbc-art-ib"
          aria-label={isFull ? 'Свернуть обратно' : 'Развернуть на весь экран'}
          title={isFull ? 'Свернуть обратно' : 'Развернуть на весь экран'}
          onClick={onToggleFull}
        >
          {isFull ? <CollapseIcon size={16} /> : <ExpandIcon size={16} />}
        </button>
        <button type="button" className="kbc-ib kbc-art-ib" aria-label="Закрыть артефакт" title="Закрыть" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="kbc-art-body">
        {commentHint}
        <div className="kbc-art-head">
          <h2 className="kbc-art-h kb-t">{artifact.title}</h2>
          {updated && <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>обновлено {updated}</span>}
          <div style={{ flex: '1 1 0' }} />
          {artifact.kind !== 'typed' && (
            <button type="button" className="kbc-btn-sm" data-fill="" onClick={() => setRefreshKey((key) => key + 1)}>
              <RefreshIcon size={14} />
              <span>Обновить</span>
            </button>
          )}
        </div>
        {artifact.description && <p className="kbc-empty" style={{ margin: '-6px 0 0', fontSize: 12 }}>{artifact.description}</p>}
        {frame}
      </div>
    </section>
  );
}
