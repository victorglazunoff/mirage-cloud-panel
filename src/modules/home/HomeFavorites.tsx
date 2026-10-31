import { ArrowRightIcon, Button, SectionRuler, StarIcon, StatusShape } from '@/modules/kabina';
import { formatElapsed, formatLastActivity, plural } from '@/modules/home/utils/homeFormatting';
import type { HomeActivityItem, HomeFavoriteProject } from '@/shared/types';

type HomeFavoritesProps = {
  index: string;
  favorites: HomeFavoriteProject[] | null;
  activity: HomeActivityItem[];
  projectCount: number;
  now: Date;
  isPhone: boolean;
  onOpenFavorite: (favorite: HomeFavoriteProject) => void;
  onOpenProjectList: () => void;
};

/** Two rows of three on desktop and three rows of two on the phone, as in the mock-ups. */
const MAX_TILES = 6;

type TileState = { dot: 'run' | 'wait' | 'idle'; status: string };

function describeTile(favorite: HomeFavoriteProject, activity: HomeActivityItem[], now: Date, isPhone: boolean): TileState {
  const own = activity.filter((item) => item.projectId === favorite.projectId);
  const waiting = own.find((item) => item.state === 'waiting');
  if (waiting) {
    const since = waiting.permission ? Date.parse(waiting.permission.receivedAt) : waiting.startedAt;
    return { dot: 'wait', status: `${isPhone ? 'Ждёт тебя' : 'Ждёт разрешения'} · ${formatElapsed(since, now.getTime())}` };
  }
  if (own.length) {
    const oldest = Math.min(...own.map((item) => item.startedAt));
    const label = own.length > 1
      ? `${own.length} ${plural(own.length, ['агент', 'агента', 'агентов'])}${isPhone ? '' : ' работают'}`
      : isPhone ? 'Агент' : 'Агент работает';
    return { dot: 'run', status: `${label} · ${formatElapsed(oldest, now.getTime())}` };
  }
  const last = formatLastActivity(favorite.lastActivity, now);
  // The phone tile is half as wide: «вчера», not «вчера 19:40».
  return { dot: 'idle', status: `Тихо · ${isPhone ? last.replace(/^(сегодня|вчера) \d{1,2}:\d{2}$/, '$1') : last}` };
}

/** Bars of the 14-day strip; the last three glow while the project is live. */
function sparkBars(values: number[], live: boolean) {
  return values.map((value, index) => {
    const hot = live && index >= values.length - 3;
    const level = Math.min(value, 9);
    return {
      height: `${3 + level * 2}px`,
      color: hot ? 'var(--kb-signal)' : value ? 'rgba(237,230,218,0.30)' : 'rgba(237,230,218,0.10)',
    };
  });
}

function shortPath(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return `~/${parts.slice(-1)[0] ?? projectPath}`;
}

/** Starred projects as instrument tiles with live status and a two-week activity strip. */
export default function HomeFavorites({
  index,
  favorites,
  activity,
  projectCount,
  now,
  isPhone,
  onOpenFavorite,
  onOpenProjectList,
}: HomeFavoritesProps) {
  const described = (favorites ?? []).slice(0, MAX_TILES).map((favorite) => ({ favorite, tile: describeTile(favorite, activity, now, isPhone) }));
  // The phone lifts what waits for you to the first tile (DarkPhoneMain).
  const tiles = isPhone ? [...described].sort((a, b) => Number(b.tile.dot === 'wait') - Number(a.tile.dot === 'wait')) : described;

  return (
    <section className={`mh-section kb-rise ${isPhone ? 'kb-d3' : 'kb-d1'}`} aria-labelledby="mh-h-fav">
      <SectionRuler id="mh-h-fav" index={index} title="ИЗБРАННОЕ" touch={isPhone}>
        <button type="button" className="kb-ruler-link kb-lnk" onClick={onOpenProjectList}>
          {isPhone ? `Все · ${projectCount} →` : `Все проекты · ${projectCount} →`}
        </button>
      </SectionRuler>

      {favorites === null && (
        <div className="mh-tiles" aria-busy="true">
          {Array.from({ length: isPhone ? 4 : 3 }, (_, skeleton) => <div key={skeleton} className="mh-tile kb-bz mh-tile-skeleton" />)}
        </div>
      )}

      {favorites !== null && tiles.length === 0 && (
        <div className="mh-empty-box kb-bz">
          <p className="kb-pretty">Отметь проекты звёздочкой в списке проектов — здесь появятся их плитки со статусом и активностью за две недели.</p>
          <Button onClick={onOpenProjectList}>Открыть проекты</Button>
        </div>
      )}

      {tiles.length > 0 && (
        <div className="mh-tiles">
          {tiles.map(({ favorite, tile }) => {
            const isWaiting = tile.dot === 'wait';
            const target = favorite.lastSessionId ? 'последний диалог' : 'проект';
            return (
              <button
                key={favorite.projectId}
                type="button"
                className="mh-tile kb-tile kb-bz"
                data-wait={isWaiting ? '' : undefined}
                aria-label={`${favorite.displayName}: ${tile.status}. Открыть ${target}`}
                onClick={() => onOpenFavorite(favorite)}
              >
                <span className="mh-tile-top">
                  <span className="mh-tile-names">
                    <span className="mh-tile-name">{favorite.displayName}</span>
                    <span className="kb-m mh-tile-path" title={favorite.projectPath}>{shortPath(favorite.projectPath)}</span>
                  </span>
                  {isWaiting && !isPhone && <span className="kb-m mh-badge-wait">ЖДЁТ ТЕБЯ</span>}
                  {!isWaiting && <StarIcon size={isPhone ? 13 : 14} className="mh-star" />}
                </span>
                <span className="mh-spark" aria-hidden="true">
                  {sparkBars(favorite.activityByDay, tile.dot !== 'idle').map((bar, barIndex) => (
                    <span key={barIndex} style={{ height: bar.height, background: bar.color }} />
                  ))}
                </span>
                <span className="mh-tile-foot">
                  <StatusShape kind={tile.dot} />
                  <span className="mh-tile-status">{tile.status}</span>
                  {!isPhone && <ArrowRightIcon className="kb-go" stroke="#FF6A2B" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
