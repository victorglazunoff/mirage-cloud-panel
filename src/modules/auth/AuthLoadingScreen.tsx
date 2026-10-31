// The Kabina layer (and its kabina.css) first: kabinaAuth.css must come after it to win over .kb-btn.
import { KabinaLogoMark } from '@/modules/kabina';
import '@/modules/auth/kabinaAuth.css';

/**
 * Rendered by the auth module's ProtectedRoute while the initial auth status check is in flight.
 * Mirage: the «Кабина» frame (grid background, mark, mono status line) in Russian instead of
 * the authors' «Loading authentication state…».
 */
export default function AuthLoadingScreen() {
  return (
    <div className="kb-root kb-auth kb-auth-loading">
      <div className="kb-auth-loading-box" role="status" aria-live="polite">
        <KabinaLogoMark size={36} />
        <span className="kb-t kb-auth-loading-word" aria-hidden="true">MIRAGE</span>
        <span className="kb-m kb-auth-loading-code">
          КАБИНА · ПРОВЕРЯЮ ВХОД
          <span className="kb-auth-cursor" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}
