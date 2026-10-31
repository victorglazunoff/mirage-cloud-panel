import { useEffect, useRef, useState } from 'react';

import '@/modules/kabina';
import SlashCommandMenu from '@/modules/kabina-commands/SlashCommandMenu';
import SlashPrefixBar, { PREFIX_HINTS } from '@/modules/kabina-commands/SlashPrefixBar';
import type { ComposerPrefix } from '@/modules/kabina-commands/SlashPrefixBar';
import { api } from '@/shared/api';
import type { Project, SlashCommandPick } from '@/shared/types';

/**
 * Used by App as the hidden test page `/__kabina/commands` (not linked anywhere): a
 * stand-in composer around SlashCommandMenu on real catalog, context and limits data, so
 * the «/» menu can be checked against DarkCommands before the chat screen embeds it.
 */
export default function KabinaCommandsDemo() {
  const inputRef = useRef<HTMLInputElement>(null);
  // Projects with their recent sessions, for the project and session pickers.
  const [projects, setProjects] = useState<Project[]>([]);
  // Picked project and session (the menu reads their catalog and context).
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The stand-in composer text.
  const [text, setText] = useState('/co');
  // Esc hides the menu until the text changes again.
  const [isClosed, setIsClosed] = useState(false);
  // What the menu last handed to the composer.
  const [lastPick, setLastPick] = useState<string>('');

  useEffect(() => {
    api.projects()
      .then((response) => (response.ok ? response.json() : []))
      .then((list: unknown) => {
        const loaded = Array.isArray(list) ? (list as Project[]) : [];
        setProjects(loaded);
        const withSessions = loaded.find((project) => (project.sessions?.length ?? 0) > 0) ?? loaded[0];
        if (withSessions) {
          setProjectId(withSessions.projectId);
          setSessionId(withSessions.sessions?.[0]?.id ?? null);
        }
      })
      .catch(() => undefined);
  }, []);

  const project = projects.find((candidate) => candidate.projectId === projectId) ?? null;
  const isMenuOpen = text.trimStart().startsWith('/') && !isClosed;
  const lead = text.trimStart().charAt(0) as ComposerPrefix;
  const hint = lastPick || (isMenuOpen ? PREFIX_HINTS['/'] : PREFIX_HINTS[lead] ?? 'Сейчас идёт ход · сообщение вклинится');

  const handlePick = (cmd: SlashCommandPick) => {
    setLastPick(`onPick → ${cmd.insertText} · ${cmd.execution}${cmd.panelAction ? ` · ${cmd.panelAction}` : ''}`);
    setText('');
    inputRef.current?.focus();
  };

  return (
    <div className="kb-root kb-shell" data-layout="page">
      <div style={{ maxWidth: 1360, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 20px', paddingBottom: 18, borderBottom: '1px solid var(--kb-line)' }}>
          <span className="kb-t" style={{ fontSize: 17, fontWeight: 600, letterSpacing: '0.34em' }}>MIRAGE</span>
          <span className="kb-m" style={{ fontSize: 11, color: 'var(--kb-mute)' }}>/__kabina/commands · тестовая страница меню «/»</span>
          <span style={{ flex: 1 }} />
          <label className="kb-m" style={{ fontSize: 11, color: 'var(--kb-soft)', display: 'flex', gap: 8, alignItems: 'center' }}>
            проект
            <select
              value={projectId ?? ''}
              onChange={(event) => {
                const next = projects.find((candidate) => candidate.projectId === event.target.value) ?? null;
                setProjectId(next?.projectId ?? null);
                setSessionId(next?.sessions?.[0]?.id ?? null);
              }}
              style={{ minHeight: 32, background: 'var(--kb-input)', color: 'var(--kb-text)', border: '1px solid var(--kb-line-btn)', borderRadius: 4 }}
            >
              {projects.map((candidate) => <option key={candidate.projectId} value={candidate.projectId}>{candidate.displayName}</option>)}
            </select>
          </label>
          <label className="kb-m" style={{ fontSize: 11, color: 'var(--kb-soft)', display: 'flex', gap: 8, alignItems: 'center' }}>
            диалог
            <select
              value={sessionId ?? ''}
              onChange={(event) => setSessionId(event.target.value || null)}
              style={{ minHeight: 32, maxWidth: 260, background: 'var(--kb-input)', color: 'var(--kb-text)', border: '1px solid var(--kb-line-btn)', borderRadius: 4 }}
            >
              <option value="">без диалога</option>
              {(project?.sessions ?? []).map((session) => (
                <option key={session.id} value={session.id}>{String(session.summary || session.title || session.id)}</option>
              ))}
            </select>
          </label>
        </header>

        <div role="log" aria-label="Лента диалога" style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: isMenuOpen ? 0.38 : 1, transition: 'opacity .25s ease' }}>
          <div style={{ alignSelf: 'flex-end', maxWidth: 620, padding: '12px 16px', background: '#1F1C18', border: '1px solid var(--kb-line-soft)', borderRadius: '8px 8px 2px 8px', fontSize: 14, lineHeight: 1.55 }}>
            Тестовая лента: меню «/» работает на настоящем каталоге команд этого сервера.
          </div>
        </div>

        {isMenuOpen && (
          <SlashCommandMenu
            query={text}
            projectId={projectId}
            sessionId={sessionId}
            onPick={handlePick}
            onComplete={(insertText) => {
              setText(insertText);
              inputRef.current?.focus();
            }}
            onClose={() => setIsClosed(true)}
          />
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 12, color: lastPick ? 'var(--kb-sage)' : 'var(--kb-mute)' }}>{hint}</span>
          <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--kb-panel)', border: '1px solid var(--kb-line-btn)', borderRadius: 8, boxShadow: '0 14px 36px rgba(0,0,0,0.4)' }}>
            <div style={{ padding: '8px 8px 8px 14px', borderBottom: '1px solid var(--kb-line-soft)' }}>
              <SlashPrefixBar
                value={text}
                onPick={(prefix) => {
                  setText(prefix);
                  setIsClosed(false);
                  setLastPick('');
                  inputRef.current?.focus();
                }}
              />
            </div>
            <label htmlFor="kbm-demo-input" className="kb-sr">Сообщение Claude или команда через «/»</label>
            <input
              id="kbm-demo-input"
              ref={inputRef}
              value={text}
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-controls="kbm-menu"
              aria-expanded={isMenuOpen}
              aria-autocomplete="list"
              placeholder="Сообщение или «/» для команд"
              onChange={(event) => {
                setText(event.target.value);
                setIsClosed(false);
                setLastPick('');
              }}
              className={text.startsWith('/') || text.startsWith('!') ? 'kb-m' : undefined}
              style={{ height: 56, padding: '0 16px', background: 'transparent', border: 'none', outline: 'none', color: 'var(--kb-text)', fontSize: 16 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
