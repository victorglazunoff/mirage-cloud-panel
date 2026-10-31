/**
 * Product identity of Mirage Cloud Panel, shared by the server, the CLI and the
 * web client so the name, the command and the repository links live in one place.
 *
 * Mirage Cloud Panel is a modified version of CloudCLI UI. The upstream
 * constants below exist only to describe that origin, as the additional terms
 * of the AGPL-3.0 (Section 7, see LICENSE) require; never use them to present
 * this software as the original CloudCLI UI.
 *
 * `package.json` cannot import this file: keep its `name`, `homepage`,
 * `repository` and `bugs` in step with the values here.
 */

/** Full product name, used in the About screen, the CLI banner and server logs. */
export const PRODUCT_NAME = 'Mirage Cloud Panel';

/** Short product name, used in the browser tab title, notifications and the PWA manifest. */
export const PRODUCT_SHORT_NAME = 'Mirage';

/** Package name (`package.json` → `name`). The package is not published to npm. */
export const PACKAGE_NAME = 'mirage-cloud-panel';

/** Name of the installed executable (`package.json` → `bin`). */
export const CLI_COMMAND = 'mirage';

/** GitHub owner of the public repository; also used for the release (update) check. */
export const REPOSITORY_OWNER = 'victorglazunoff';

/** GitHub name of the public repository; also used for the release (update) check. */
export const REPOSITORY_NAME = 'mirage-cloud-panel';

/** Public source repository — the AGPL-3.0 §13 "source of the running version" link. */
export const REPOSITORY_URL = `https://github.com/${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;

/** Where users report bugs. */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

/** Release list, the target of the "update available" links. */
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

/**
 * How a git checkout of the panel updates itself (run in the panel folder, then restart
 * the service). Used by the CLI (`mirage update`), the server's update endpoint and the
 * update dialog; the package is not on npm, so there is no `npm install -g` path.
 */
export const GIT_UPDATE_COMMAND = 'git pull --ff-only && npm ci --include=dev && npm run build';

/** Name of the upstream project this one is derived from (origin description only). */
export const UPSTREAM_NAME = 'CloudCLI UI';

/** Upstream repository (origin description only). */
export const UPSTREAM_URL = 'https://github.com/siteboon/claudecodeui';

/** Attribution notice required verbatim by LICENSE, ADDITIONAL TERMS §1. */
export const UPSTREAM_ATTRIBUTION = `${UPSTREAM_NAME} (${UPSTREAM_URL})`;
