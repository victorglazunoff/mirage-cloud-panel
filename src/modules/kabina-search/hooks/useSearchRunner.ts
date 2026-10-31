import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { kabinaChatPath, kabinaLimitsHref, matchKabinaRoute, useKabinaToasts } from '@/modules/kabina';
import { api } from '@/shared/api';
import { addToDraftText, readDraftText, writeDraftText } from '@/shared/chatDrafts';
import type { KabinaProjectRef, SearchResultItem } from '@/shared/types';
import { getServerHomeDir } from '@/shared/utils';

/** Where ⌘K was opened from: the chat on screen, if any. */
export type SearchOrigin = { projectId: string | null; sessionId: string | null };

/** Prompt the «Спросить Claude» row puts in front of the question for the main assistant. */
const ASK_PREFIX = 'Поищи по всем проектам, диалогам и файлам панели и ответь сводкой со ссылками: ';

/**
 * The project that plays the «главный ассистент»: the home folder project, else the first
 * starred, else the first. Exported for tests.
 */
export function pickAssistantProject(projects: KabinaProjectRef[], home: string | null = getServerHomeDir()): KabinaProjectRef | null {
  return projects.find((project) => project.path === '~' || (home !== null && project.path.replace(/\/+$/, '') === home))
    ?? projects.find((project) => project.isStarred)
    ?? projects[0]
    ?? null;
}

/**
 * Used by KabinaSearch: what Enter / ⌘Enter / the preview buttons do for each kind of row.
 * Every navigation replaces the `?search` history entry, so the overlay closes and Back
 * returns to the screen it was opened from. Text meant for Claude is put into the target
 * chat's composer draft (the composer picks it up live) — it is never sent on its own.
 */
export function useSearchRunner(projects: KabinaProjectRef[], onClose: () => void) {
  const navigate = useNavigate();
  const location = useLocation();
  const { show } = useKabinaToasts();
  const route = matchKabinaRoute(location.pathname, location.search);
  const origin: SearchOrigin = route.screen === 'chat'
    ? { projectId: route.projectId, sessionId: route.sessionId }
    : { projectId: null, sessionId: null };

  const go = useCallback((to: string) => navigate(to, { replace: true }), [navigate]);

  /**
   * Puts `text` into a chat's composer and opens that chat. What is typed there stays: a mention
   * joins the line, a question goes after it, a command goes first (it must lead).
   */
  const prefillChat = useCallback((projectId: string | null, sessionId: string | null, text: string, place: 'mention' | 'end' | 'start' = 'end') => {
    const write = (scope: string) => {
      if (place === 'mention') {
        const typed = readDraftText(scope).trimEnd();
        writeDraftText(scope, typed ? `${typed} ${text}` : text);
      } else {
        addToDraftText(scope, text, place);
      }
    };
    if (sessionId) {
      write(sessionId);
      go(projectId ? kabinaChatPath(projectId, sessionId) : `/session/${encodeURIComponent(sessionId)}`);
      return true;
    }
    if (projectId) {
      write(`project:${projectId}`);
      go(kabinaChatPath(projectId));
      return true;
    }
    return false;
  }, [go]);

  const ask = useCallback((question: string) => {
    const assistant = pickAssistantProject(projects);
    const trimmed = question.trim();
    if (!assistant) {
      show({ kind: 'wait', title: 'Некому задать вопрос', sub: 'добавь проект — в нём откроется главный ассистент', durationMs: 5_000 });
      return;
    }
    // The chat opens with the question in its composer — that is the confirmation; no bell entry.
    prefillChat(assistant.projectId, null, trimmed ? `${ASK_PREFIX}${trimmed}` : '');
  }, [prefillChat, projects, show]);

  const runCommand = useCallback((item: SearchResultItem) => {
    const text = `${item.commandName ?? item.title} `;
    const projectId = origin.projectId ?? item.projectId ?? pickAssistantProject(projects)?.projectId ?? null;
    const sessionId = origin.projectId ? origin.sessionId : null;
    if (!prefillChat(projectId, sessionId, text, 'start')) {
      show({ kind: 'wait', title: 'Негде выполнить команду', sub: 'открой проект — команда встанет в его поле ввода', durationMs: 5_000 });
    }
    // Success needs no bell entry: the command is already seen in the chat's composer.
  }, [origin.projectId, origin.sessionId, prefillChat, projects, show]);

  const runAction = useCallback((item: SearchResultItem, query: string) => {
    switch (item.actionId) {
      case 'new_session': {
        const projectId = item.projectId ?? origin.projectId;
        if (projectId) prefillChat(projectId, null, query.trim() ? `${query.trim()} ` : '');
        else go('/projects');
        return;
      }
      case 'open_calendar': go('/calendar'); return;
      case 'open_agents': go('/agents'); return;
      case 'open_files': go(origin.projectId ? `/files?project=${encodeURIComponent(origin.projectId)}` : '/files'); return;
      case 'open_projects': go('/projects'); return;
      case 'open_settings': go('/settings'); return;
      // The limits panel opens over the screen ⌘K was called from.
      case 'show_usage': go(kabinaLimitsHref(location.pathname)); return;
      case 'voice_input': navigate({ pathname: location.pathname, search: '?voice' }, { replace: true }); return;
      case 'compact_session': {
        if (!origin.sessionId) {
          show({ kind: 'wait', title: 'Сжимать нечего', sub: 'открой диалог — /compact сожмёт именно его', durationMs: 5_000 });
          return;
        }
        api.compactSession(origin.sessionId)
          .then((response) => {
            // Queued is the expected outcome (the chat shows it); only a failure reaches the bell.
            if (!response.ok) throw new Error(String(response.status));
          })
          .catch(() => show({ kind: 'wait', title: 'Не получилось поставить сжатие', sub: 'попробуй /compact в поле ввода', durationMs: 6_000 }));
        onClose();
        return;
      }
      case 'toggle_theme':
        show({ kind: 'ok', title: 'Тема одна — «Кабина»', sub: 'светлая появится в настройках позже', durationMs: 4_000 });
        onClose();
        return;
      default:
        onClose();
    }
  }, [go, location.pathname, navigate, onClose, origin.projectId, origin.sessionId, prefillChat, show]);

  /** Opens a hit: Enter on a row and the preview's primary button. */
  const open = useCallback((item: SearchResultItem | null, query: string) => {
    if (!item) {
      ask(query);
      return;
    }
    switch (item.type) {
      case 'project':
        go(kabinaChatPath(item.projectId ?? item.id));
        return;
      case 'session':
        if (item.sessionId) {
          go(item.projectId ? kabinaChatPath(item.projectId, item.sessionId) : `/session/${encodeURIComponent(item.sessionId)}`);
        }
        return;
      case 'file': {
        const params = new URLSearchParams();
        if (item.projectId) params.set('project', item.projectId);
        if (item.path) params.set('file', item.path);
        go(`/files?${params.toString()}`);
        return;
      }
      case 'command':
        runCommand(item);
        return;
      case 'action':
        runAction(item, query);
        return;
      default:
        onClose();
    }
  }, [ask, go, onClose, runAction, runCommand]);

  /** «Упомянуть @ в чате»: the file goes into the composer of its project's new chat (or the open chat). */
  const mentionFile = useCallback((item: SearchResultItem, relativePath: string) => {
    const sameProject = origin.projectId && origin.projectId === item.projectId;
    prefillChat(item.projectId, sameProject ? origin.sessionId : null, `@${relativePath} `, 'mention');
  }, [origin.projectId, origin.sessionId, prefillChat]);

  /**
   * Esc: just closes. ⌘K brings the same query back (searchMemory); a «Поиск закрыт» entry
   * would only add to the bell's «N новых» — the centre is for events, not echoes of a key press.
   */
  const dismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  return { origin, open, ask, mentionFile, go, dismiss };
}
