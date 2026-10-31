import { Button, ListSkeleton, SectionRuler, StatusShape } from '@/modules/kabina';
import { buildActivityRows } from '@/modules/home/utils/homeActivityRows';
import { formatElapsed, plural } from '@/modules/home/utils/homeFormatting';
import type { HomeActivityItem } from '@/shared/types';

type HomeActivityListProps = {
  index: string;
  activity: HomeActivityItem[] | null;
  now: Date;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
};

/** More rows than this push the rest of the screen out of view. */
const MAX_ROWS = 8;

/** "В работе" (DarkMain 02): live turns, prompts waiting for the user and background agents, each with its way in. */
export default function HomeActivityList({ index, activity, now, onOpenSession }: HomeActivityListProps) {
  const rows = buildActivityRows(activity ?? []);
  const turns = rows.filter((row) => row.kind !== 'bg').length;
  const background = rows.length - turns;
  const visible = rows.slice(0, MAX_ROWS);

  return (
    <section id="mh-run" className="mh-section kb-rise kb-d2" data-tight="" aria-labelledby="mh-h-run">
      <SectionRuler id="mh-h-run" index={index} title="В РАБОТЕ">
        <span className="kb-m kb-ruler-meta">
          {turns} {plural(turns, ['ход', 'хода', 'ходов'])} · {background} {plural(background, ['фоновый агент', 'фоновых агента', 'фоновых агентов'])}
        </span>
      </SectionRuler>

      <ol className="mh-rows">
        {activity === null && <li><ListSkeleton rows={2} label="Смотрю, что идёт" /></li>}
        {activity !== null && visible.length === 0 && (
          <li className="mh-empty mh-empty-idle">
            <StatusShape kind="idle" />
            <span className="kb-pretty">Все агенты отдыхают. Новый ход или фоновый агент появится здесь сразу.</span>
          </li>
        )}
        {visible.map((row, rowIndex) => {
          const isWait = row.kind === 'wait';
          return (
            <li key={row.key} className="mh-row kb-row">
              <span className="kb-m mh-row-n">{String(rowIndex + 1).padStart(2, '0')}</span>
              <StatusShape kind={isWait ? 'wait' : 'run'} />
              <span className="mh-row-proj" title={row.project}>{row.project}</span>
              <span className="mh-row-what kb-pretty">
                {row.what}
                {row.command && (
                  <>
                    {' '}
                    <code className="kb-m">{row.command}</code>
                  </>
                )}
              </span>
              <span className="mh-bar" aria-hidden="true">
                <span className={isWait ? 'mh-bar-wait' : 'mh-bar-run'} />
              </span>
              <span className="kb-m mh-row-dur">{formatElapsed(row.since, now.getTime())}</span>
              <Button
                variant={isWait ? 'pri' : 'ghost'}
                className="mh-row-btn"
                aria-label={`${isWait ? 'Ответить' : 'Открыть'}: ${row.project}`}
                onClick={() => onOpenSession(row.sessionId, row.projectId)}
              >
                {isWait ? 'Ответить' : 'Открыть'}
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
