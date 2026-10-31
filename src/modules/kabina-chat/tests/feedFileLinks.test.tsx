import assert from 'node:assert/strict';
import { createRef } from 'react';
import type { ReactNode } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, it } from 'vitest';

import { FileLinkContext } from '@/modules/chat';
import ChatFeed from '@/modules/kabina-chat/ChatFeed';
import { buildFileHref, useFeedFileLinks } from '@/modules/kabina-chat/FilePathLink';
import { buildChatFeed } from '@/modules/kabina-chat/utils/chatFeed';
import type { ChatMessage } from '@/shared/types';

/**
 * Mirage: file paths in the Kabina feed — in Claude's text (code spans and
 * plain text) and in the journal — open the file in Files.
 */

afterEach(cleanup);

describe('buildFileHref', () => {
  it('opens a relative path in the project, with its line', () => {
    assert.equal(
      buildFileHref({ path: 'src/App.tsx', line: 42 }, 'p1', '/root'),
      '/files?project=p1&file=src%2FApp.tsx&line=42',
    );
  });

  it('places ~/ in the home folder, and gives up without one', () => {
    assert.equal(buildFileHref({ path: '~/notes/a.md', line: null }, 'p1', '/root'), '/files?project=p1&file=%2Froot%2Fnotes%2Fa.md');
    assert.equal(buildFileHref({ path: '~/notes/a.md', line: null }, 'p1', null), null);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function Providers({ children }: { children: ReactNode }) {
  const links = useFeedFileLinks('p1', '/root');
  return <FileLinkContext.Provider value={links}>{children}</FileLinkContext.Provider>;
}

const T = '2026-10-27T10:00:00.000Z';

function renderFeed(messages: ChatMessage[]) {
  const feed = buildChatFeed(messages, Date.parse(T));
  return render(
    <MemoryRouter initialEntries={['/p/p1/s/s1']}>
      <Routes>
        <Route
          path="*"
          element={(
            <Providers>
              <ChatFeed
                items={feed.items}
                isPhone={false}
                scrollRef={createRef<HTMLDivElement>()}
                onScroll={() => undefined}
                hasMore={false}
                isLoadingMore={false}
                onLoadEarlier={() => undefined}
                isLoading={false}
                openArtifactId={null}
                onToggleArtifact={() => undefined}
                decision={null}
                emptyHint=""
                isProcessing={false}
                actions={{ retry: () => undefined, resume: () => undefined, switchToSonnet: null }}
                liveAgents={new Map()}
                now={Date.parse(T)}
              />
              <LocationProbe />
            </Providers>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('paths in the feed', () => {
  it('turn a code span and a plain-text path in Claude\'s reply into links to Files', () => {
    renderFeed([
      { type: 'user', content: 'где макет?', timestamp: T },
      { type: 'assistant', content: 'Макет: `export/landing-maket.html`, правка в src/App.tsx:42. Сайт https://example.com/a.html', timestamp: T },
    ]);
    const links = screen.getAllByTitle('Открыть в файлах');
    assert.deepEqual(links.map((link) => link.getAttribute('href')), [
      '/files?project=p1&file=export%2Flanding-maket.html',
      '/files?project=p1&file=src%2FApp.tsx&line=42',
    ]);
    // The web address stays an ordinary link.
    assert.equal(screen.getByText('https://example.com/a.html').closest('a')?.getAttribute('title'), null);

    fireEvent.click(links[0]);
    assert.equal(screen.getByTestId('location').textContent, '/files?project=p1&file=export%2Flanding-maket.html');
  });

  it('leaves a ⌘/Ctrl-click to the browser (new tab)', () => {
    renderFeed([{ type: 'assistant', content: 'см. `README.md`', timestamp: T }]);
    const link = screen.getByTitle('Открыть в файлах');
    fireEvent.click(link, { metaKey: true });
    assert.equal(screen.getByTestId('location').textContent, '/p/p1/s/s1');
  });

  it('link the file of a journal step, and the row still unfolds', () => {
    renderFeed([
      { type: 'user', content: 'прочитай', timestamp: T },
      {
        type: 'assistant', isToolUse: true, toolName: 'Read', toolId: 'r1', timestamp: T,
        toolInput: JSON.stringify({ file_path: '/root/proj/src/App.tsx' }), toolResult: { content: '1\tconst a = 1;', isError: false },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /ЖУРНАЛ/ }));
    const link = screen.getByTitle('Открыть в файлах');
    assert.equal(link.getAttribute('href'), '/files?project=p1&file=%2Froot%2Fproj%2Fsrc%2FApp.tsx');
    const row = screen.getByRole('button', { name: /#1 Read/ });
    fireEvent.click(row);
    assert.equal(row.getAttribute('aria-expanded'), 'true');
  });
});
