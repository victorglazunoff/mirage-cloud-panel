import assert from 'node:assert/strict';

import React from 'react';
import { render } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/**
 * A stopped turn reads as a quiet "stopped" mark: a `turn_stopped` row, which
 * the client adds live when a turn ends aborted and the server reads from the
 * CLI's interruption row on a history load.
 */

const renderMessage = (message: ChatMessage) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );

test('a turn_stopped row becomes a "stopped" mark', () => {
  const [row] = normalizedToChatMessages([{
    id: 'stop-1',
    kind: 'turn_stopped',
    provider: 'claude',
    sessionId: 's',
    timestamp: '2026-10-26T05:16:41.000Z',
  } as NormalizedMessage]);

  assert.equal(row?.isTurnStopped, true);
  const { container } = renderMessage(row);
  assert.match(container.textContent ?? '', /stopped/);
  assert.ok(container.querySelector('[title="The turn was stopped"]'));
});

test('an ordinary answer is not a mark, whatever it says', () => {
  const { container } = renderMessage({
    type: 'assistant',
    content: 'No response requested.',
    timestamp: '2026-10-26T05:16:41.000Z',
  });

  assert.match(container.textContent ?? '', /No response requested/);
  assert.equal(container.querySelector('[title="The turn was stopped"]'), null);
});
