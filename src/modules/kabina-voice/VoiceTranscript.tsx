import { useEffect, useState } from 'react';

type VoiceTranscriptProps = {
  /** Recognised phrase; empty while recording or waiting for the server. */
  text: string;
  /** Word indexes the parse recognised (underlined). */
  marked: Set<number>;
  /** Shown with the caret while there is no text yet. */
  placeholder: string;
  className: string;
};

/** Pause between two words appearing — the mock's «по словам» reveal. */
const WORD_STEP_MS = 55;

/**
 * Used by both voice layouts for «РАСШИФРОВКА»: the phrase appears word by word
 * (blur → sharp), the newest word white with the caret after it, recognised words
 * underlined in orange. SpeechKit answers once per phrase, so the words reveal when
 * the text arrives rather than while speaking.
 */
export function VoiceTranscript({ text, marked, placeholder, className }: VoiceTranscriptProps) {
  const words = text ? text.split(/\s+/) : [];
  // How many words are already on screen; grows one by one after the text arrives.
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setShown(0);
    if (!text) return undefined;
    const total = text.split(/\s+/).length;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      setShown(count);
      if (count >= total) window.clearInterval(timer);
    }, WORD_STEP_MS);
    return () => window.clearInterval(timer);
  }, [text]);

  if (words.length === 0) {
    return (
      <p className={className} aria-live="polite">
        <span className="kb-vo-wait">{placeholder}</span>
        <span className="kb-vo-caret" aria-hidden="true" />
      </p>
    );
  }

  const revealing = shown < words.length;
  return (
    <p className={className} aria-live="polite" aria-label={text}>
      {words.map((word, index) => {
        const on = index < shown;
        const last = revealing ? index === shown - 1 : index === words.length - 1;
        return (
          <span
            // Words of one phrase never reorder.
            key={index}
            className="kb-vo-word"
            aria-hidden="true"
            data-on={on ? '' : undefined}
            data-last={on && last ? '' : undefined}
            data-mark={marked.has(index) ? '' : undefined}
          >
            {word}
            {on && last && <span className="kb-vo-caret" aria-hidden="true" />}
          </span>
        );
      })}
    </p>
  );
}
