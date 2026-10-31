import { useEffect, useRef } from 'react';

/**
 * ⌘N / Ctrl+N — a new dialog (where the browser lets a page have it). Only while the
 * chat itself is on screen: in the project's Terminal Ctrl+N is the shell's «next
 * command», and in Files it belongs to the editor — there it must not throw the user
 * out of the dialog into a new empty one.
 */
export function useNewDialogShortcut(enabled: boolean, onNewDialog: () => void) {
  const onNewDialogRef = useRef(onNewDialog);
  onNewDialogRef.current = onNewDialog;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        onNewDialogRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
