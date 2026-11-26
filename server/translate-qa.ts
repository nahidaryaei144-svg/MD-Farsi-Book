/* Automatic translation quality assessment (QA Gatekeeper) & language classifier.

   Used in two places:
   1. Immediately after a provider returns a segment, to verify placeholder
      integrity, absence of protocol remnants/chatter, reasonable length ratio,
      and target-script compliance before caching in translation memory.
   2. During `review` mode scanning, to distinguish already-healthy target-language
      segments from untranslated source segments or half-translated/broken ones. */

export type QaIssue =
    | 'none'
    | 'empty'
    | 'protocol'
    | 'placeholder'
    | 'chatter'
    | 'identity'
    | 'length'
    | 'script'
    | 'untranslated';

export interface QaResult {
    ok: boolean;
    issue: QaIssue;
    reason?: string;
}

const PLACEHOLDER_RE = /⟦\d+⟧/g;
const RESIDUAL_PROTOCOL_RE = /\[\[p\d+\]\]|\[\[(?:source_end|end|terms)\]\]/i;

const CHATTER_PREFIXES = [
    /^(?:here\s+is|here's)\s+the\s+translation\b[^:\n]*[:：]?/i,
    /^translated\s+text\s*[:：]/i,
    /^(?:sure|certainly|of\s+course)[,!]?\s+(?:here\s+is|i\s+have\s+translated)\b/i,
    /^i(?:'m|\s+am)\s+sorry[,!]?\s+(?:but\s+)?i\s+cannot\s+(?:translate|fulfill|assist)/i,
    /^i\s+cannot\s+translate\b/i,
    /^ترجمهٔ?\s+متن(?:\s+بالا|\s+زیر|\s+فوق)?\s*[:：]/,
    /^متأسفم[،,]?\s+نمی‌?توانم/
];

const ARABIC_ONLY_CHARS_RE = /[ةىكيٱٲٳٵٶٷٸ]/g;
const ARABIC_DIACRITICS_RE = /[\u064B-\u0652\u0670]/g;
const PERSIAN_ONLY_CHARS_RE = /[پچژگ]/g;
const PERSIAN_YE_KE_RE = /[یک]/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;
const ARABIC_SCRIPT_LETTER_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g;
const GARBLED_ARABIC_QUOTE_RE = /«[^»\n]{4,}(?:[\u064B-\u0652][^»\n]*){3,}»/;
const BAD_SAD_PAGE_ARTIFACT_RE = /(?:^|[\s(«\[])ص\s*[۲2]{2}\.\s*[\d\u06F0-\u06F9]+/;

/* Unambiguously Arabic function words that should not remain in Persian prose
   (outside quoted Quranic/hadith braces `{...}`). */
const ARABIC_FUNCTION_WORDS = new Set([
    'الذي',
    'التي',
    'الذين',
    'اللاتي',
    'اللواتي',
    'هذا',
    'هذه',
    'هؤلاء',
    'اولئك',
    'أولئك',
    'ذلك',
    'تلك',
    'انه',
    'أنه',
    'انها',
    'إنها',
    'فان',
    'فإن',
    'بان',
    'بأن',
    'لان',
    'لأن',
    'عليهم',
    'اليهم',
    'إليهم',
    'منهم',
    'فيهم',
    'عنهم',
    'فيها',
    'منها',
    'اليها',
    'إليها',
    'عليها',
    'عندما',
    'بينما',
    'حيث',
    'ايضا',
    'أيضا',
    'أيضاً',
    'جدا',
    'جداً',
    'لكي',
    'ولكن',
    'لكن',
    'كما',
    'اذن',
    'إذن',
    'ليس',
    'ليست',
    'كان',
    'كانت',
    'يكون',
    'تكون',
    'قد',
    'لقد',
    'سوف',
    'اذا',
    'إذا',
    'نحو',
    'نعم',
    'كلا'
]);

/* Common Persian words starting with "ال" that must not trigger the Arabic
   definite-article (`الـ`) heuristic. */
const PERSIAN_AL_LOANWORDS = new Set([
    'البته',
    'الان',
    'الآن',
    'الماس',
    'الگو',
    'الگوها',
    'الگوی',
    'الزام',
    'الزامی',
    'الزاما',
    'الفبا',
    'الفبای',
    'التماس',
    'الوداع',
    'الهام',
    'الحاق',
    'الکتریکی',
    'الکترونیک',
    'الکترونیکی',
    'الکل',
    'المپیک',
    'الومینیوم',
    'الهی',
    'الهیات',
    'الهیه',
    'الیاف',
    'التهاب'
]);

const PERSIAN_SIGNAL_WORDS = new Set([
    'است',
    'هست',
    'نیست',
    'بود',
    'شد',
    'می',
    'نمی',
    'شود',
    'می‌شود',
    'نمی‌شود',
    'کند',
    'می‌کند',
    'کرد',
    'دارد',
    'ندارد',
    'داشت',
    'برای',
    'این',
    'آن',
    'که',
    'را',
    'از',
    'به',
    'در',
    'با',
    'بر',
    'های',
    'هایی',
    'هایش',
    'باشد',
    'باشند',
    'شدند',
    'بودند',
    'کردند',
    'استفاده',
    'بسیار',
    'همه',
    'چون',
    'زیرا',
    'اگر',
    'اما',
    'ولی',
    'یا',
    'و'
]);

export function canonicalTargetLang(target: string): 'fa' | 'en' | 'ar' | 'other' {
    const raw = (target || '').trim().toLowerCase();
    if (!raw) return 'fa';
    if (raw === 'fa' || raw.startsWith('fa-') || raw.startsWith('fa_') || raw === 'persian' || raw === 'farsi' || raw === 'فارسی') {
        return 'fa';
    }
    if (raw === 'en' || raw.startsWith('en-') || raw.startsWith('en_') || raw === 'english' || raw === 'انگلیسی') {
        return 'en';
    }
    if (raw === 'ar' || raw.startsWith('ar-') || raw.startsWith('ar_') || raw === 'arabic' || raw === 'عربی') {
        return 'ar';
    }
    return 'other';
}

/** Strips placeholders, inline code, URLs, and quoted Quranic braces `{...}`
    so language heuristics judge only the translated prose. */
function stripNonProseForQa(text: string): string {
    return text
        .replace(PLACEHOLDER_RE, ' ')
        .replace(/`[^`]+`/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{[^{}\n]{1,400}\}/g, ' ');
}

export function normalizeForQa(text: string): string {
    return text
        .replace(PLACEHOLDER_RE, ' ')
        .replace(ARABIC_DIACRITICS_RE, '')
        .replace(/ي/g, 'ی')
        .replace(/ى/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/ة/g, 'ه')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/\u200c/g, '')
        .replace(/[\p{P}\p{S}\s]+/gu, ' ')
        .trim()
        .toLowerCase();
}

export function extractPlaceholderCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    const matches = text.match(PLACEHOLDER_RE);
    if (!matches) return counts;
    for (const token of matches) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
}

export function placeholdersMatch(source: string, translation: string): boolean {
    const src = extractPlaceholderCounts(source);
    const dst = extractPlaceholderCounts(translation);
    if (src.size !== dst.size) return false;
    for (const [token, count] of src) {
        if (dst.get(token) !== count) return false;
    }
    return true;
}

function countLetters(text: string): { total: number; latin: number; arabicScript: number } {
    const letters = text.match(/\p{L}/gu);
    if (!letters) return { total: 0, latin: 0, arabicScript: 0 };
    const latin = (text.match(LATIN_LETTER_RE) ?? []).length;
    const arabicScript = (text.match(ARABIC_SCRIPT_LETTER_RE) ?? []).length;
    return { total: letters.length, latin, arabicScript };
}

function analyzeArabicVsPersian(prose: string): {
    words: number;
    arabicOnlyChars: number;
    diacritics: number;
    persianOnlyChars: number;
    persianYeKe: number;
    arabicFunctionHits: number;
    persianSignalHits: number;
    alPrefixHits: number;
} {
    const clean = prose.replace(/[\p{P}\p{S}\d\u06F0-\u06F9\u0660-\u0669]+/gu, ' ');
    const tokens = clean.split(/\s+/).filter((w) => w.length >= 2);
    const arabicOnlyChars = (prose.match(ARABIC_ONLY_CHARS_RE) ?? []).length;
    const diacritics = (prose.match(ARABIC_DIACRITICS_RE) ?? []).length;
    const persianOnlyChars = (prose.match(PERSIAN_ONLY_CHARS_RE) ?? []).length;
    const persianYeKe = (prose.match(PERSIAN_YE_KE_RE) ?? []).length;

    let arabicFunctionHits = 0;
    let persianSignalHits = 0;
    let alPrefixHits = 0;

    for (const rawWord of tokens) {
        const bare = rawWord.replace(ARABIC_DIACRITICS_RE, '');
        const norm = bare.replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه');
        if (ARABIC_FUNCTION_WORDS.has(bare) || ARABIC_FUNCTION_WORDS.has(norm)) {
            arabicFunctionHits += 1;
        }
        if (PERSIAN_SIGNAL_WORDS.has(norm) || norm.startsWith('می\u200c') || norm.startsWith('نمی\u200c')) {
            persianSignalHits += 1;
        }
        if (bare.length >= 4 && bare.startsWith('ال') && !PERSIAN_AL_LOANWORDS.has(norm)) {
            alPrefixHits += 1;
        }
    }

    return {
        words: tokens.length,
        arabicOnlyChars,
        diacritics,
        persianOnlyChars,
        persianYeKe,
        arabicFunctionHits,
        persianSignalHits,
        alPrefixHits
    };
}

/** Assesses whether a `(source, translation)` pair is structurally and linguistically valid. */
export function assessTranslation(
    source: string,
    translation: string,
    target: string,
    options?: { allowIdentity?: boolean; checkPlaceholders?: boolean }
): QaResult {
    const trimmed = translation.trim();
    if (!trimmed) {
        return { ok: false, issue: 'empty', reason: 'پاسخ خالی است.' };
    }

    if (RESIDUAL_PROTOCOL_RE.test(trimmed)) {
        return { ok: false, issue: 'protocol', reason: 'بقایای پروتکل [[pN]] در متن دیده شد.' };
    }

    if (options?.checkPlaceholders !== false && !placeholdersMatch(source, trimmed)) {
        return { ok: false, issue: 'placeholder', reason: 'نگهدارنده‌های قالب‌بندی (⟦N⟧) ناقص یا تغییر یافته‌اند.' };
    }

    for (const pattern of CHATTER_PREFIXES) {
        if (pattern.test(trimmed)) {
            return { ok: false, issue: 'chatter', reason: 'متن اضافی یا پیام خطای مدل در خروجی وجود دارد.' };
        }
    }

    const srcProse = stripNonProseForQa(source);
    const dstProse = stripNonProseForQa(trimmed);
    const srcLetters = countLetters(srcProse);
    const dstLetters = countLetters(dstProse);

    /* Length ratio anomaly on non-trivial prose */
    if (srcLetters.total >= 35) {
        const ratio = dstLetters.total / srcLetters.total;
        if (ratio < 0.22) {
            return { ok: false, issue: 'length', reason: 'ترجمه به‌طور غیرعادی کوتاه یا بریده شده است.' };
        }
        if (ratio > 3.8) {
            return { ok: false, issue: 'length', reason: 'ترجمه به‌طور غیرعادی طولانی یا دارای تکرار/توضیح اضافی است.' };
        }
    }

    /* Identity check: multi-word source copied verbatim without translating */
    if (!options?.allowIdentity && srcLetters.total >= 18) {
        const srcWords = srcProse.trim().split(/\s+/).filter(Boolean);
        if (srcWords.length >= 4 && normalizeForQa(srcProse) === normalizeForQa(dstProse)) {
            return { ok: false, issue: 'identity', reason: 'متن مبدأ بدون ترجمه عیناً بازگردانده شده است.' };
        }
    }

    const lang = canonicalTargetLang(target);
    if (lang === 'fa') {
        if (BAD_SAD_PAGE_ARTIFACT_RE.test(trimmed) && !/[2٢]{2}/.test(source)) {
            return { ok: false, issue: 'script', reason: 'ارجاع صفحه به صورت نادرست («ص ۲۲.») برگردانده شده است.' };
        }
        if (GARBLED_ARABIC_QUOTE_RE.test(trimmed) && !/صلی‌الله|رحمه‌الله|رضی‌الله/.test(trimmed)) {
            return { ok: false, issue: 'untranslated', reason: 'عبارت نقل‌قول قرآنی یا عربی در ترجمه مخدوش شده است.' };
        }
    }
    if (lang === 'fa' && dstLetters.total >= 16) {
        /* Remaining Latin script check (allow short brand/technical names) */
        if (dstLetters.latin / dstLetters.total > 0.35 && dstLetters.latin >= 10) {
            return { ok: false, issue: 'script', reason: 'بخش زیادی از متن همچنان به خط لاتین مانده است.' };
        }
        const stats = analyzeArabicVsPersian(dstProse);
        if (stats.words >= 5) {
            const arabicPressure =
                stats.arabicFunctionHits >= 3 ||
                (stats.arabicOnlyChars >= 3 && stats.persianOnlyChars === 0 && stats.persianSignalHits === 0) ||
                (stats.alPrefixHits >= 3 && stats.alPrefixHits / stats.words >= 0.35 && stats.persianSignalHits === 0);
            if (arabicPressure) {
                return { ok: false, issue: 'untranslated', reason: 'متن همچنان به زبان عربی است و به فارسی برگردانده نشده.' };
            }
        }
    } else if (lang === 'en' && dstLetters.total >= 16) {
        if (dstLetters.arabicScript / dstLetters.total > 0.2 && dstLetters.arabicScript >= 6) {
            return { ok: false, issue: 'script', reason: 'متن همچنان حاوی نویسه‌های عربی/فارسی است.' };
        }
    } else if (lang === 'ar' && dstLetters.total >= 16) {
        if (dstLetters.latin / dstLetters.total > 0.35 && dstLetters.latin >= 10) {
            return { ok: false, issue: 'script', reason: 'بخش زیادی از متن همچنان به خط لاتین مانده است.' };
        }
        const stats = analyzeArabicVsPersian(dstProse);
        if (stats.persianOnlyChars >= 2) {
            return { ok: false, issue: 'script', reason: 'نویسه‌های اختصاصی فارسی در متن عربی باقی مانده است.' };
        }
    }

    return { ok: true, issue: 'none' };
}

/** Classifies an existing monolingual segment during `review` mode.
    Returns:
    - `'ok'` when the segment already looks healthy in the target language (skip it!)
    - `'untranslated'` when the segment is clearly still in a non-target language
    - `'suspicious'` when the segment has broken protocol/placeholders or mixed/corrupt scripts */
export function classifyExistingText(text: string, target: string): 'ok' | 'untranslated' | 'suspicious' {
    const trimmed = text.trim();
    if (!trimmed) return 'ok';
    if (RESIDUAL_PROTOCOL_RE.test(trimmed) || PLACEHOLDER_RE.test(trimmed)) {
        return 'suspicious';
    }
    for (const pattern of CHATTER_PREFIXES) {
        if (pattern.test(trimmed)) return 'suspicious';
    }

    const prose = stripNonProseForQa(trimmed);
    const letters = countLetters(prose);
    if (letters.total < 6) return 'ok';

    const lang = canonicalTargetLang(target);

    if (lang === 'fa') {
        if (BAD_SAD_PAGE_ARTIFACT_RE.test(trimmed)) return 'suspicious';
        if (GARBLED_ARABIC_QUOTE_RE.test(trimmed) && !/صلی‌الله|رحمه‌الله|رضی‌الله/.test(trimmed)) {
            return 'suspicious';
        }
        const latinRatio = letters.latin / letters.total;
        if (latinRatio >= 0.6 && letters.latin >= 6) return 'untranslated';
        if (latinRatio >= 0.28 && letters.latin >= 10) return 'suspicious';

        const stats = analyzeArabicVsPersian(prose);
        if (stats.words >= 3) {
            const strongArabic =
                stats.arabicFunctionHits >= 2 ||
                (stats.arabicOnlyChars >= 2 && stats.persianOnlyChars === 0 && stats.persianSignalHits === 0) ||
                (stats.diacritics >= 4 && stats.persianSignalHits === 0 && stats.persianOnlyChars === 0) ||
                (stats.alPrefixHits >= 2 && stats.alPrefixHits / stats.words >= 0.35 && stats.persianSignalHits === 0);
            if (strongArabic) {
                return stats.persianSignalHits > 0 || stats.persianOnlyChars > 0
                    ? 'suspicious'
                    : 'untranslated';
            }
            if (stats.arabicOnlyChars >= 2 && (stats.persianSignalHits > 0 || stats.persianOnlyChars > 0)) {
                return 'suspicious';
            }
        } else if (stats.arabicOnlyChars >= 2 && stats.persianYeKe === 0 && stats.persianOnlyChars === 0) {
            return 'untranslated';
        }
        return 'ok';
    }

    if (lang === 'en') {
        const arabicRatio = letters.arabicScript / letters.total;
        if (arabicRatio >= 0.55) return 'untranslated';
        if (arabicRatio >= 0.15) return 'suspicious';
        return 'ok';
    }

    if (lang === 'ar') {
        const latinRatio = letters.latin / letters.total;
        if (latinRatio >= 0.6 && letters.latin >= 6) return 'untranslated';
        if (latinRatio >= 0.28 && letters.latin >= 10) return 'suspicious';
        const stats = analyzeArabicVsPersian(prose);
        if (stats.persianOnlyChars >= 2 || stats.persianSignalHits >= 2) {
            return stats.arabicFunctionHits > 0 ? 'suspicious' : 'untranslated';
        }
        return 'ok';
    }

    return 'ok';
}
