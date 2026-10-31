// «Активные входы» (DarkSettings 05.3): what device a sign-in came from and
// where, read from its User-Agent and IP — «Mac · Chrome», «iPhone · Safari»,
// «Скрипт · curl»; a loopback IP is «этот сервер», a private one «локальная сеть».

/** Icon of a sign-in row. */
export type SessionDeviceKind = 'phone' | 'tablet' | 'laptop' | 'script';

export type SessionDevice = { label: string; kind: SessionDeviceKind };

const SCRIPTS: Array<[RegExp, string]> = [
  [/python-urllib|python-requests|aiohttp|httpx/i, 'Python'],
  [/curl\//i, 'curl'],
  [/wget/i, 'wget'],
  [/node|undici|axios/i, 'Node'],
  [/go-http-client/i, 'Go'],
  [/postman/i, 'Postman'],
];

function osOf(ua: string): string | null {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}

function browserOf(ua: string): string | null {
  if (/YaBrowser\//.test(ua)) return 'Яндекс Браузер';
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/(Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/HeadlessChrome/.test(ua)) return 'Chrome без окна';
  if (/(Chrome|CriOS)\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  if (/Telegram/i.test(ua)) return 'Telegram';
  return null;
}

/** «Mac · Chrome» with its icon; a request made by a program is «Скрипт · curl». */
export function describeSessionDevice(userAgent: string | null, fallbackLabel: string): SessionDevice {
  const ua = (userAgent ?? '').trim();
  if (!ua) return { label: fallbackLabel === 'Неизвестное устройство' ? 'Без подписи браузера' : fallbackLabel, kind: 'laptop' };
  const script = SCRIPTS.find(([pattern]) => pattern.test(ua));
  if (script && !/Mozilla\//.test(ua)) return { label: `Скрипт · ${script[1]}`, kind: 'script' };
  const os = osOf(ua);
  const browser = browserOf(ua);
  const label = [os, browser].filter(Boolean).join(' · ') || fallbackLabel;
  const isPhone = os === 'iPhone' || (os === 'Android' && /Mobile/.test(ua));
  const kind: SessionDeviceKind = isPhone ? 'phone' : os === 'iPad' || os === 'Android' ? 'tablet' : 'laptop';
  return { label, kind };
}

/** «этот сервер» for loopback, «локальная сеть» for private ranges, the IP itself otherwise; null when unknown. */
export function describeSessionPlace(ip: string | null): string | null {
  if (!ip) return null;
  const address = ip.replace(/^::ffff:/, '');
  if (address === '::1' || /^127\./.test(address) || address === 'localhost') return 'этот сервер';
  if (/^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe80:/i.test(address)) {
    return 'локальная сеть';
  }
  return address;
}
