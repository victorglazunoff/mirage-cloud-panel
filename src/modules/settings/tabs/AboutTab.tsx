import { ArrowUpRight, Bug, Tag } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ISSUES_URL,
  PRODUCT_NAME,
  RELEASES_URL,
  REPOSITORY_NAME,
  REPOSITORY_OWNER,
  REPOSITORY_URL,
  UPSTREAM_NAME,
  UPSTREAM_URL,
} from '@/shared/constants';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';
import { MirageLogo } from '@/shared/ui';

/** Repository path shown under the "Source code" link, e.g. `victorglazunoff/mirage-cloud-panel`. */
const REPOSITORY_LABEL = `${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

type AboutLinkRowProps = {
  href: string;
  icon: ReactNode;
  label: string;
  detail?: string;
};

/** One row of the links list: icon, label, optional mono detail, and an arrow that nudges on hover. */
function AboutLinkRow({ href, icon, label, detail }: AboutLinkRowProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-h-11 items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
    >
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {detail && <span className="block truncate font-mono text-[11px] text-muted-foreground">{detail}</span>}
      </span>
      <ArrowUpRight
        className="h-4 w-4 flex-none text-muted-foreground/60 transition-transform duration-150 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </a>
  );
}

/**
 * Rendered by Settings for the "about" tab: name and version, the public source
 * (AGPL-3.0 §13), and the origin notice the LICENSE additional terms (§7) require —
 * the verbatim CloudCLI UI attribution and the "modified version" marking.
 */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { updateAvailable, latestVersion, currentVersion, releaseInfo } = useVersionCheck(REPOSITORY_OWNER, REPOSITORY_NAME);
  const releasesUrl = releaseInfo?.htmlUrl || RELEASES_URL;

  return (
    <div className="space-y-6">
      {/* Mark + name + version */}
      <div className="flex items-start gap-3.5">
        <span className="flex h-12 w-12 flex-none items-center justify-center rounded-xl border border-border/60 bg-muted/40">
          <MirageLogo withWordmark={false} size={30} />
        </span>
        <div className="min-w-0 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="kb-t text-lg font-semibold leading-tight tracking-wide text-foreground [text-wrap:balance]">
              {PRODUCT_NAME}
            </h3>
            <a
              href={releasesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              v{currentVersion}
            </a>
            {updateAvailable && latestVersion && (
              <a
                href={releasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 transition-colors duration-150 hover:bg-green-500/20 dark:text-green-400"
              >
                {t('apiKeys.version.updateAvailable', { version: latestVersion })}
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground [text-wrap:pretty]">{t('about.tagline')}</p>
        </div>
      </div>

      {/* Source, issues, releases */}
      <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
        <AboutLinkRow
          href={REPOSITORY_URL}
          icon={<GitHubIcon className="h-4 w-4" />}
          label={t('about.sourceCode')}
          detail={REPOSITORY_LABEL}
        />
        <AboutLinkRow href={`${ISSUES_URL}/new`} icon={<Bug className="h-4 w-4" />} label={t('about.reportIssue')} />
        <AboutLinkRow href={RELEASES_URL} icon={<Tag className="h-4 w-4" />} label={t('about.releases')} />
      </div>

      {/* Origin: LICENSE additional terms §1 (attribution) and §2 (modified version marking) */}
      <section aria-labelledby="about-origin-title" className="rounded-xl border border-border/60 bg-muted/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="about-origin-title" className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {t('about.originTitle')}
          </h4>
          <span className="rounded-full border border-orange-500/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-orange-600 dark:text-orange-400">
            {t('about.modifiedVersion')}
          </span>
        </div>
        <p className="mt-3 text-sm text-foreground [overflow-wrap:anywhere]">
          {t('about.basedOn')}{' '}
          <a
            href={UPSTREAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline decoration-border underline-offset-4 transition-colors duration-150 hover:decoration-foreground"
          >
            {UPSTREAM_NAME} ({UPSTREAM_URL})
          </a>
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground [text-wrap:pretty]">
          {t('about.modifiedNotice', { product: PRODUCT_NAME, upstream: UPSTREAM_NAME })}
        </p>
      </section>

      {/* License */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-4 text-xs text-muted-foreground">
        <span>{t('about.licensed')}</span>
        <a
          href={`${REPOSITORY_URL}/blob/main/LICENSE`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground"
        >
          LICENSE
        </a>
        <a
          href={`${REPOSITORY_URL}/blob/main/NOTICE`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground"
        >
          NOTICE
        </a>
      </div>
    </div>
  );
}
