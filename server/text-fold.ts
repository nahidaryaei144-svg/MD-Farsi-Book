/**
 * Persian/Arabic text folding for the content index. It mirrors the folding the
 * client search uses (`src/lib/search.ts`), so a book skipped by the index can
 * never contain a query term that the client would have found.
 */

const LETTER_FOLD: Record<string, string> = {
    'ي': 'ی',
    'ى': 'ی',
    'ئ': 'ی',
    'ك': 'ک',
    'ة': 'ه',
    'ۀ': 'ه',
    'أ': 'ا',
    'إ': 'ا',
    'آ': 'ا',
    'ٱ': 'ا',
    'ؤ': 'و',
    'ء': ''
};

const REMOVABLE = /[\u064B-\u0652\u0670\u0640\u200E\u200F\u202A-\u202E]/g;
const MAPPED_LETTERS = /[يكةۀأإآٱؤء]/g;
const DIGITS = /[\u06F0-\u06F9\u0660-\u0669]/g;
const JOINERS = /[\u200C\u200D]/g;
const SPACES = /\s+/g;

function foldDigit(digit: string): string {
    const code = digit.charCodeAt(0);
    return code >= 0x06f0 ? String(code - 0x06f0) : String(code - 0x0660);
}

/**
 * Lowercased, letter-folded text with collapsed whitespace.
 *
 * Native string passes instead of a per-character loop: this runs over every
 * byte of a multi-gigabyte library and is the hottest part of indexing.
 */
export function foldText(value: string): string {
    return String(value || '')
        .replace(REMOVABLE, '')
        .replace(DIGITS, foldDigit)
        .replace(MAPPED_LETTERS, (letter) => LETTER_FOLD[letter] ?? letter)
        .replace(JOINERS, ' ')
        .replace(SPACES, ' ')
        .trim()
        .toLowerCase();
}

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenizeFolded(folded: string): string[] {
    const tokens: string[] = [];
    WORD_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORD_PATTERN.exec(folded))) {
        // One-letter tokens are too common to be a useful skip signal; queries
        // that consist only of such tokens bypass the index.
        if (match[0].length >= 2) tokens.push(match[0]);
        if (tokens.length > 500000) break;
    }
    return tokens;
}

/** Folds a single word (not a whole document). */
export function foldToken(token: string): string {
    return token
        .replace(REMOVABLE, '')
        .replace(DIGITS, foldDigit)
        .replace(MAPPED_LETTERS, (letter) => LETTER_FOLD[letter] ?? letter)
        .toLowerCase();
}

/**
 * Distinct indexable words of a document.
 *
 * Splitting the original text and folding only the distinct words is several
 * times faster than folding every character of a multi-gigabyte library, and
 * it yields exactly the same tokens a folded document would.
 */
export function distinctTokens(value: string): Set<string> {
    const seen = new Set<string>();
    const parts = String(value || '').split(/[^\p{L}\p{N}]+/u);
    for (const part of parts) {
        if (part.length < 2) continue;
        const token = foldToken(part);
        if (token.length >= 2) seen.add(token);
    }
    return seen;
}

export function stripFrontmatterOffset(content: string): number {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return match ? match[0].length : content.charCodeAt(0) === 0xfeff ? 1 : 0;
}
