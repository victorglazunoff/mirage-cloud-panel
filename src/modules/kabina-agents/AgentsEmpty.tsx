import { Link } from 'react-router-dom';

type AgentsEmptyProps = {
  /** «Последний закончил в 13:58 — Карта участков, SEO-тексты, 14 из 14.» or a first-run line. */
  text: string;
  /** Where «Запустить воркфлоу» leads: the chat of the last project that worked, else the project list. */
  startTo: string;
};

/** Used by the «Агенты» screen when nothing runs anywhere: DarkStates Z4 «Все агенты отдыхают». */
export default function AgentsEmpty({ text, startTo }: AgentsEmptyProps) {
  return (
    <article className="kba-empty kb-bz kb-rise kb-d2" aria-labelledby="kba-empty-h">
      <div className="kba-empty-in">
        <div className="kba-empty-icon kb-bz" aria-hidden="true">
          <span>
            <span className="kba-led kba-led-off" />
            <span className="kba-led kba-led-off" />
            <span className="kba-led kba-led-off" />
            <span className="kba-led kba-led-off" />
          </span>
        </div>
        <div className="kba-empty-text">
          <h3 id="kba-empty-h">Все агенты отдыхают</h3>
          <p>{text}</p>
        </div>
        <Link className="kb-btn kb-ghost" to={startTo}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Запустить воркфлоу
        </Link>
        <span className="kb-m kba-empty-hint">откроется чат проекта — скажи, что запустить</span>
      </div>
    </article>
  );
}
