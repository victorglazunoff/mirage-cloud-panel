import type { MatchParts } from '@/shared/types';

/** Renders a `splitMatch` result with the hit in `<mark>` (DarkSearch rows and preview). */
export default function SearchHighlight({ parts }: { parts: MatchParts }) {
  return (
    <>
      {parts.before}
      {parts.match && <mark>{parts.match}</mark>}
      {parts.after}
    </>
  );
}
