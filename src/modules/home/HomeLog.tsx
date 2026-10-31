import { ListSkeleton, SectionRuler } from '@/modules/kabina';
import { formatLastActivity, formatLogTime } from '@/modules/home/utils/homeFormatting';
import type { HomeRecentSession } from '@/shared/types';

type HomeLogProps = {
  index: string;
  recent: HomeRecentSession[] | null;
  now: Date;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  onOpenProjectList: () => void;
};

function isWithinLastHour(iso: string | null, now: Date): boolean {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return !Number.isNaN(time) && now.getTime() - time < 60 * 60 * 1000;
}

/** "Бортовой журнал" (DarkMain 03): the most recently active conversations across all projects. */
export default function HomeLog({ index, recent, now, onOpenSession, onOpenProjectList }: HomeLogProps) {
  return (
    <section className="mh-section kb-rise kb-d3" data-tight="" aria-labelledby="mh-h-log">
      <SectionRuler id="mh-h-log" index={index} title="БОРТОВОЙ ЖУРНАЛ">
        <button type="button" className="kb-ruler-link kb-lnk" onClick={onOpenProjectList}>Вся история →</button>
      </SectionRuler>
      <ol className="mh-rows">
        {recent === null && <li><ListSkeleton rows={5} label="Читаю журнал" /></li>}
        {recent !== null && recent.length === 0 && <li className="mh-empty">Диалогов пока не было.</li>}
        {(recent ?? []).map((entry) => (
          <li key={entry.sessionId}>
            <button type="button" className="mh-row mh-log-row kb-row" onClick={() => onOpenSession(entry.sessionId, entry.projectId)}>
              <span className="kb-m mh-row-time">{formatLogTime(entry.lastActivity, now)}</span>
              <span className="mh-log-proj" title={entry.projectName}>{entry.projectName}</span>
              <span className="mh-log-what kb-pretty">{entry.sessionTitle}</span>
              {/* The time column already dates older entries; only the last hour gets "N мин назад". */}
              {isWithinLastHour(entry.lastActivity, now) && (
                <span className="kb-m mh-row-res">{formatLastActivity(entry.lastActivity, now)}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
