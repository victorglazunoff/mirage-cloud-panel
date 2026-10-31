import { Button } from '@/modules/kabina/ui/Button';
import { WifiOffIcon } from '@/modules/kabina/ui/KabinaIcons';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';

type ConnectionBannerProps =
  | { state: 'lost'; attempt: number; secondsToRetry: number; retryShare: number; onRetry: () => void }
  | { state: 'back'; downForSeconds: number };

/** Rendered by KabinaShell on every screen (DarkStates C1), a thin strip under the header: «Нет связи» / «Связь восстановлена». */
export default function ConnectionBanner(props: ConnectionBannerProps) {
  if (props.state === 'back') {
    return (
      <div className="kb-netbar kb-fadein" data-state="back" role="status" aria-live="polite">
        <StatusShape kind="ok" />
        <span className="kb-netbar-title">Связь восстановлена</span>
        <span className="kb-m kb-netbar-meta">не было {props.downForSeconds}&nbsp;с · догрузил пропущенное</span>
      </div>
    );
  }

  return (
    <div className="kb-netbar kb-fadein" data-state="lost" role="status" aria-live="polite">
      <WifiOffIcon stroke="#D9A35B" style={{ flex: 'none' }} />
      <span className="kb-netbar-title">Нет связи</span>
      <span className="kb-m kb-netbar-meta">попытка {props.attempt} · через {props.secondsToRetry}&nbsp;с</span>
      <span className="kb-netbar-note">переподключаюсь — ход на сервере идёт дальше</span>
      <span className="kb-netbar-progress" aria-hidden="true">
        <span style={{ width: `${Math.round(props.retryShare * 100)}%` }} />
      </span>
      <Button size="sm" variant="ghost" onClick={props.onRetry}>Сейчас</Button>
    </div>
  );
}
