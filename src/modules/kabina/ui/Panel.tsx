import type { HTMLAttributes } from 'react';

import { cn } from '@/shared/utils';

type PanelProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article' | 'aside';
  /** `panel` — #1A1916 instrument plate, `well` — the darker #161512 inset, `wait` — the orange-edged "ждёт тебя" plate. */
  tone?: 'panel' | 'well' | 'wait';
  /** The corner marks (top-left and bottom-right brackets); on by default as in the mock-ups. */
  corners?: boolean;
};

/** Used by the home, shell overlays and soon-screens: the bordered «Кабина» plate with corner marks. */
export function Panel({ as: Tag = 'div', tone = 'panel', corners = true, className, ...rest }: PanelProps) {
  return (
    <Tag
      className={cn('kb-panel', corners && 'kb-bz', className)}
      data-tone={tone === 'panel' ? undefined : tone}
      {...rest}
    />
  );
}
