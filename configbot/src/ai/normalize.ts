/**
 * Persian text normalisation — the TypeScript port of `termuxapp/normalize.py`.
 *
 * Why this exists at all
 * ----------------------
 * Persian is written inconsistently in ways that break naive matching:
 *
 *  - Arabic ي (U+064A) and Persian ی (U+06CC) are different code points for the
 *    same letter, and keyboards disagree about which one they send.
 *  - Arabic ك (U+0643) vs Persian ک (U+06A9), same story.
 *  - The zero-width non-joiner (U+200C) is used in compound words like
 *    «می‌خواهم», but users type it, omit it, or replace it with a space at
 *    random.
 *
 * `normalize()` gives a comparable form. `compact()` additionally collapses
 * ZWNJ and spaces so «کانفیگ‌ها», «کانفیگ ها» and «کانفیگها» all match the same
 * pattern. Both are needed: normalising ZWNJ to a space in a single function
 * silently breaks every regex written for a compound word, which is a bug we
 * already hit once in the Python assistant.
 */

/** Arabic -> Persian letter folding, plus digit folding to ASCII. */
const LETTER_MAP: Record<string, string> = {
  '\u064A': '\u06CC', // Arabic ي -> Persian ی
  '\u0649': '\u06CC', // Arabic ى -> Persian ی
  '\u0643': '\u06A9', // Arabic ك -> Persian ک
  '\u0622': '\u0627', // آ -> ا
  '\u0623': '\u0627', // أ -> ا
  '\u0625': '\u0627', // إ -> ا
  '\u0671': '\u0627', // ٱ -> ا
};

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export const ZWNJ = '\u200C';

/**
 * Fold letters and digits, drop diacritics, collapse whitespace.
 * ZWNJ becomes a space here — use `compact()` when you also want it removed.
 */
export function normalize(input: string): string {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    if (ch === ZWNJ) {
      out += ' ';
      continue;
    }
    const mapped = LETTER_MAP[ch];
    if (mapped) {
      out += mapped;
      continue;
    }
    const fa = FA_DIGITS.indexOf(ch);
    if (fa >= 0) {
      out += String(fa);
      continue;
    }
    const ar = AR_DIGITS.indexOf(ch);
    if (ar >= 0) {
      out += String(ar);
      continue;
    }
    // Arabic diacritics (tashkeel) carry no meaning for matching.
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x064b && code <= 0x0652) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * `normalize()` plus removal of ZWNJ and intra-word spaces, so compound-word
 * spellings collapse onto one form.
 *
 * «می‌خواهم» -> «میخواهم», «کانفیگ‌ها» -> «کانفیگها».
 */
export function compact(input: string): string {
  return normalize(input).replace(/[\s\u200C]/g, '');
}

/**
 * Match a needle against a haystack regardless of how either was typed.
 * Returns true if the compacted forms match by substring.
 */
export function persianIncludes(haystack: string, needle: string): boolean {
  return compact(haystack).includes(compact(needle));
}

/** Strip Markdown/HTML the model might emit before it goes into a caption. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert ASCII digits to Persian, for display only. */
export function toPersianDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d);
}

/** Convert Persian/Arabic digits back to ASCII, for parsing. */
export function toAsciiDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}
