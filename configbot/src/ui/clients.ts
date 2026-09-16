/**
 * The VPN client apps the site points people at.
 *
 * ── Why we do not ship our own .exe / .apk ─────────────────────────────────
 * A VPN client is a native binary: on Windows it has to install a TUN/Wintun
 * driver and run as a service, on Android it has to bind a VpnService and be
 * signed with a release key. Producing either needs a real toolchain (MSVC or
 * MinGW for the .exe; the Android SDK, Gradle and a signing keystore for the
 * .apk) plus code signing, which is exactly the part that cannot be faked —
 * an unsigned or self-signed "VPN installer" is a red flag every antivirus and
 * every cautious user is right to refuse.
 *
 * So this module lists the real, open-source clients whose releases we checked
 * by name against the GitHub API. Every URL below was verified to resolve;
 * a deliberately wrong asset name returns 404, so these 302s are genuine.
 *
 * To refresh the versions:
 *   curl -s https://api.github.com/repos/hiddify/hiddify-app/releases/latest \
 *     | jq -r '.tag_name, (.assets[].name)'
 */

export type ClientPlatform = 'windows' | 'android' | 'macos' | 'linux' | 'ios';

export interface ClientDownload {
  id: string;
  /** Product name, shown as the heading. */
  name: string;
  platform: ClientPlatform;
  /** Human-readable architecture note, e.g. «۶۴ بیت». */
  arch: string;
  /** The exact release asset filename. */
  file: string;
  ext: 'exe' | 'apk' | 'zip' | 'dmg' | 'appimage' | 'store';
  sizeMb: number;
  url: string;
  /** Where it comes from — shown to the user, because trust matters here. */
  source: string;
  /** One-line reason to pick this one over the others. */
  why: string;
  /** Our recommendation for that platform. */
  primary?: boolean;
}

const GH = 'https://github.com';

/** Release tags verified on 2026-09-17. */
const HID = 'v4.1.1';
const VNG = '2.2.6';
const V2N = '7.24.9';

export const CLIENTS: ClientDownload[] = [
  {
    id: 'hiddify-win',
    name: 'Hiddify',
    platform: 'windows',
    arch: '۶۴ بیت',
    file: 'Hiddify-Windows-Setup-x64.exe',
    ext: 'exe',
    sizeMb: 34,
    url: `${GH}/hiddify/hiddify-app/releases/download/${HID}/Hiddify-Windows-Setup-x64.exe`,
    source: 'hiddify/hiddify-app — نسخه‌ی رسمی',
    why: 'نصب خودکار، رابط ساده، لینک اشتراک را با یک کلیک می‌گیرد.',
    primary: true,
  },
  {
    id: 'v2rayn-win',
    name: 'v2rayN',
    platform: 'windows',
    arch: '۶۴ بیت',
    file: 'v2rayN-windows-64.zip',
    ext: 'zip',
    sizeMb: 149,
    url: `${GH}/2dust/v2rayN/releases/download/${V2N}/v2rayN-windows-64.zip`,
    source: '2dust/v2rayN — نسخه‌ی رسمی',
    why: 'سبک‌تر و دقیق‌تر برای کسی که می‌خواهد پروتکل و routing را دستی تنظیم کند.',
  },
  {
    id: 'hiddify-android',
    name: 'Hiddify',
    platform: 'android',
    arch: 'arm64 — اکثر گوشی‌های جدید',
    file: 'Hiddify-Android-arm64.apk',
    ext: 'apk',
    sizeMb: 113,
    url: `${GH}/hiddify/hiddify-app/releases/download/${HID}/Hiddify-Android-arm64.apk`,
    source: 'hiddify/hiddify-app — نسخه‌ی رسمی',
    why: 'بهترین انتخاب روی اندروید؛ اشتراک را خودش به‌روز می‌کند.',
    primary: true,
  },
  {
    id: 'v2rayng-android',
    name: 'v2rayNG',
    platform: 'android',
    arch: 'arm64',
    file: `v2rayNG_${VNG}_arm64-v8a.apk`,
    ext: 'apk',
    sizeMb: 27,
    url: `${GH}/2dust/v2rayNG/releases/download/${VNG}/v2rayNG_${VNG}_arm64-v8a.apk`,
    source: '2dust/v2rayNG — نسخه‌ی رسمی',
    why: 'حجمش یک‌پنجم Hiddify است؛ برای اینترنت ضعیف یا گوشی قدیمی بهتر است.',
  },
  {
    id: 'v2rayng-android-v7',
    name: 'v2rayNG',
    platform: 'android',
    arch: 'armeabi-v7a — گوشی‌های قدیمی‌تر',
    file: `v2rayNG_${VNG}_armeabi-v7a.apk`,
    ext: 'apk',
    sizeMb: 27,
    url: `${GH}/2dust/v2rayNG/releases/download/${VNG}/v2rayNG_${VNG}_armeabi-v7a.apk`,
    source: '2dust/v2rayNG — نسخه‌ی رسمی',
    why: 'اگر نسخه‌ی arm64 روی گوشی‌ات نصب نشد، این را بردار.',
  },
  {
    id: 'hiddify-macos',
    name: 'Hiddify',
    platform: 'macos',
    arch: 'Intel و Apple Silicon',
    file: 'Hiddify-MacOS.dmg',
    ext: 'dmg',
    sizeMb: 79,
    url: `${GH}/hiddify/hiddify-app/releases/download/${HID}/Hiddify-MacOS.dmg`,
    source: 'hiddify/hiddify-app — نسخه‌ی رسمی',
    why: 'نسخه‌ی مک با امضای خود پروژه.',
    primary: true,
  },
  {
    id: 'hiddify-linux',
    name: 'Hiddify',
    platform: 'linux',
    arch: 'x64 — AppImage',
    file: 'Hiddify-Linux-x64-AppImage.AppImage',
    ext: 'appimage',
    sizeMb: 52,
    url: `${GH}/hiddify/hiddify-app/releases/download/${HID}/Hiddify-Linux-x64-AppImage.AppImage`,
    source: 'hiddify/hiddify-app — نسخه‌ی رسمی',
    why: 'بدون نصب اجرا می‌شود: فقط chmod +x و اجرا.',
    primary: true,
  },
];

/**
 * iOS cannot be served as a file.
 *
 * An .ipa is useless to anyone without a developer certificate or a jailbreak,
 * and we verified no App Store URL from this environment, so we do not print a
 * link we have not checked. We tell them what to search for instead — which is
 * honest and it actually works.
 */
export const IOS_NOTE =
  'روی آیفون فایل نصب وجود ندارد. در App Store یکی از این‌ها را جستجو کن: ' +
  '«Hiddify»، «Streisand» یا «v2rayNG». بعد از نصب، لینک اشتراک را کپی کن و ' +
  'در برنامه Import کن.';

export function clientsFor(platform: ClientPlatform): ClientDownload[] {
  return CLIENTS.filter((c) => c.platform === platform);
}

export function primaryClient(platform: ClientPlatform): ClientDownload | undefined {
  return CLIENTS.find((c) => c.platform === platform && c.primary);
}

/**
 * Guess the platform from a User-Agent.
 *
 * Only used to sort the download page so the right block comes first — never
 * to decide what someone is allowed to download.
 */
export function guessPlatform(userAgent: string | null): ClientPlatform {
  const ua = (userAgent ?? '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/mac os x|macintosh/.test(ua)) return 'macos';
  if (/linux|x11/.test(ua)) return 'linux';
  return 'windows';
}

export const PLATFORM_ORDER: ClientPlatform[] = [
  'android',
  'windows',
  'ios',
  'macos',
  'linux',
];

export const PLATFORM_LABEL: Record<ClientPlatform, string> = {
  android: 'اندروید',
  windows: 'ویندوز',
  ios: 'آیفون / آیپد',
  macos: 'مک',
  linux: 'لینوکس',
};

/** Rough guess at which Android ABI a device needs, for the helper text. */
export function androidAbiHint(userAgent: string | null): string {
  const ua = userAgent ?? '';
  // Browsers rarely expose the ABI, so we default to arm64 and say so.
  if (/wv|Android 4|Android 5/.test(ua)) {
    return 'گوشی‌ت قدیمی به نظر می‌رسد؛ اگر arm64 نصب نشد نسخه‌ی armeabi-v7a را بردار.';
  }
  return 'اگر نمی‌دانی کدام معماری، همان arm64 را بردار — روی گوشی‌های ۲۰۱۷ به بعد درست است.';
}
