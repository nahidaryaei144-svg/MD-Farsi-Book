import type {
    BookSummary,
    SearchBookResult,
    SearchField,
    SearchIndexing,
    SearchOptions,
    SearchOutcome,
    SearchPageHit,
    SearchQueryField,
    SearchSnippet,
    SearchSnippetKind,
    SearchSnippetRange
} from '../types';
import { bookSearchPages } from './markdown';

export const defaultSearchOptions: SearchOptions = {
    // Exact phrase matching keeps the default result set small: only the
    // letters typed, in the same order, are matched. Typo tolerance is off.
    mode: 'phrase',
    fuzzy: 0,
    wholeWord: false,
    caseSensitive: false,
    includeHeadings: true,
    includeFootnotes: true,
    headingsOnly: false,
    sort: 'relevance'
};

const MAX_SNIPPETS_PER_PAGE = 6;
const MAX_MATCHES_PER_TERM_LINE = 24;
const FUZZY_TEXT_LIMIT = 4000;

const FIELD_LOOKUP: Record<string, SearchField> = {
    'نام': 'title',
    'عنوان': 'title',
    'title': 'title',
    'name': 'title',
    'نویسنده': 'author',
    'مولف': 'author',
    'author': 'author',
    'مترجم': 'translator',
    'translator': 'translator',
    'موضوع': 'section',
    'بخش': 'section',
    'دسته': 'section',
    'section': 'section',
    'category': 'section',
    'برچسب': 'tag',
    'برچسبها': 'tag',
    'تگ': 'tag',
    'tag': 'tag',
    'tags': 'tag',
    'پوشه': 'folder',
    'قفسه': 'folder',
    'folder': 'folder'
};

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

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isRemovable(code: number): boolean {
    return (
        (code >= 0x064b && code <= 0x065f) ||
        code === 0x0670 ||
        (code >= 0x06d6 && code <= 0x06ed) ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e)
    );
}

function foldChar(char: string): string {
    if (LETTER_FOLD[char] !== undefined) return LETTER_FOLD[char];
    const code = char.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    if (char === '\u200c' || char === '\u200d' || char === '\u00a0') return ' ';
    if (char === '\u0640' || isRemovable(code)) return '';
    return char;
}

export interface NormalizedLine {
    text: string;
    map: number[];
}

/** Folds Persian/Arabic letter variants, diacritics and digits, keeping a map back to the original text. */
export function normalizeLine(original: string, caseSensitive = false): NormalizedLine {
    const chars: string[] = [];
    const map: number[] = [];
    let previousSpace = false;

    for (let index = 0; index < original.length; index += 1) {
        const folded = foldChar(original[index]);
        if (!folded) continue;
        const piece = caseSensitive ? folded : folded.toLowerCase();
        for (const unit of piece) {
            if (/\s/.test(unit)) {
                if (previousSpace) continue;
                previousSpace = true;
                chars.push(' ');
                map.push(index);
                continue;
            }
            previousSpace = false;
            chars.push(unit);
            map.push(index);
        }
    }

    let start = 0;
    let end = chars.length;
    while (start < end && chars[start] === ' ') start += 1;
    while (end > start && chars[end - 1] === ' ') end -= 1;

    return { text: chars.slice(start, end).join(''), map: map.slice(start, end) };
}

export function normalizeTerm(value: string, caseSensitive = false): string {
    return normalizeLine(value, caseSensitive).text;
}

function isWordChar(char: string | undefined): boolean {
    return Boolean(char) && WORD_CHAR.test(char as string);
}

interface Range {
    start: number;
    end: number;
}

interface LeafTerm {
    raw: string;
    text: string;
    negative: boolean;
    wildcard: boolean;
    regex: boolean;
    phrase: boolean;
    pattern: RegExp | null;
}

export interface ParsedQuery {
    terms: LeafTerm[];
    fields: SearchQueryField[];
    anyMode: boolean;
    error: string;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFieldKey(value: string): string {
    return value.replace(/[\u200c\s_-]/g, '').toLocaleLowerCase('fa');
}

function unquote(value: string): string {
    const text = value.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
    return text;
}

const FIELD_PATTERN = /(^|[\s(])(-?)([\p{L}\u200c_]{2,})\s*:\s*("[^"]*"|\S+)/gu;

function parseFields(raw: string): { rest: string; fields: SearchQueryField[] } {
    const fields: SearchQueryField[] = [];
    const rest = raw.replace(FIELD_PATTERN, (full, lead: string, negative: string, key: string, value: string) => {
        const field = FIELD_LOOKUP[normalizeFieldKey(key)];
        if (!field) return full;
        const text = unquote(value);
        if (!text) return lead;
        fields.push({ field, value: text, negative: negative === '-' });
        return lead;
    });
    return { rest, fields };
}

function foldRegexSource(source: string, caseSensitive: boolean): string {
    let output = '';
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '\\') {
            output += char + (source[index + 1] ?? '');
            index += 1;
            continue;
        }
        if (/[()[\]{}|^$.*+?]/.test(char)) {
            output += char;
            continue;
        }
        const folded = foldChar(char);
        output += caseSensitive ? folded : folded.toLowerCase();
    }
    return output;
}

function compileRegex(source: string, caseSensitive: boolean): RegExp | null {
    const folded = foldRegexSource(source, caseSensitive);
    for (const flags of [caseSensitive ? 'gu' : 'giu', caseSensitive ? 'g' : 'gi']) {
        try {
            return new RegExp(folded, flags);
        } catch {
            continue;
        }
    }
    return null;
}

function makeTerm(text: string, negative: boolean, phrase: boolean, wildcard: boolean, caseSensitive: boolean): LeafTerm {
    const normalized = normalizeTerm(text, caseSensitive);
    return {
        raw: text,
        text: wildcard ? normalized.replace(/\*+$/, '') : normalized,
        negative,
        wildcard,
        regex: false,
        phrase,
        pattern: null
    };
}

export function parseQuery(raw: string, options: SearchOptions): ParsedQuery {
    const { rest, fields } = parseFields(raw);
    const terms: LeafTerm[] = [];
    const empty = { terms, fields, anyMode: false, error: '' };
    let anyMode = false;
    const trimmed = rest.trim();

    if (options.mode === 'regex') {
        if (!trimmed) return empty;
        const pattern = compileRegex(trimmed, options.caseSensitive);
        if (!pattern) return { ...empty, error: 'الگوی منظم (RegEx) نامعتبر است.' };
        terms.push({ raw: trimmed, text: '', negative: false, wildcard: false, regex: true, phrase: false, pattern });
        return { terms, fields, anyMode: false, error: '' };
    }

    if (options.mode === 'phrase') {
        const phrase = unquote(trimmed);
        if (phrase) terms.push(makeTerm(phrase, false, true, false, options.caseSensitive));
        return { terms, fields, anyMode: false, error: '' };
    }

    const tokenPattern = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(rest))) {
        const quoted = match[1] !== undefined;
        let text = (quoted ? match[1] : match[2] || '').trim();
        if (!text) continue;

        if (!quoted && ['|', 'OR', 'or', 'یا'].includes(text)) {
            anyMode = true;
            continue;
        }

        let negative = false;
        if ((text.startsWith('-') || text.startsWith('!')) && text.length > 1) {
            negative = true;
            text = text.slice(1).trim();
        }
        if (!text) continue;

        const wildcard = !quoted && /[*؟?]$/.test(text) && text.length > 1;
        if (wildcard) text = text.slice(0, -1).trim();
        if (!text) continue;

        terms.push(makeTerm(text, negative, quoted || text.includes(' '), wildcard, options.caseSensitive));
    }

    if (options.mode === 'any') anyMode = true;
    if (!terms.length && !fields.length) return { terms, fields, anyMode, error: '' };
    if (!terms.some((term) => !term.negative) && fields.every((field) => field.negative)) {
        return { terms, fields, anyMode, error: 'عبارت جست‌وجو خالی است؛ یک واژه یا فیلد مثبت اضافه کنید.' };
    }

    return { terms, fields, anyMode, error: '' };
}

export function describeQuery(raw: string, options: SearchOptions): {
    terms: string[];
    fields: SearchQueryField[];
    error: string;
    anyMode: boolean;
} {
    const parsed = parseQuery(raw, options);
    return {
        terms: parsed.terms.map((term) => `${term.negative ? '−' : ''}${term.raw}`),
        fields: parsed.fields,
        error: parsed.error,
        anyMode: parsed.anyMode
    };
}

function withinDistance(source: string, target: string, max: number): boolean {
    if (Math.abs(source.length - target.length) > max) return false;
    if (source === target) return true;
    let previous = new Array(target.length + 1).fill(0).map((_, index) => index);
    for (let row = 1; row <= source.length; row += 1) {
        const current = [row];
        let rowBest = row;
        for (let column = 1; column <= target.length; column += 1) {
            const cost = source[row - 1] === target[column - 1] ? 0 : 1;
            const value = Math.min(
                (previous[column] ?? 0) + 1,
                (current[column - 1] ?? 0) + 1,
                (previous[column - 1] ?? 0) + cost
            );
            current[column] = value;
            if (value < rowBest) rowBest = value;
        }
        if (rowBest > max) return false;
        previous = current;
    }
    return (previous[target.length] ?? max + 1) <= max;
}

function fuzzyMatches(text: string, needle: string, max: number, existing: Range[]): Range[] {
    if (needle.length < 4 || text.length > FUZZY_TEXT_LIMIT) return [];
    const found: Range[] = [];
    const minLength = Math.max(2, needle.length - max);
    const maxLength = needle.length + max;

    for (let index = 0; index < text.length; index += 1) {
        if (!isWordChar(text[index]) || isWordChar(text[index - 1])) continue;
        for (let length = minLength; length <= maxLength && index + length <= text.length; length += 1) {
            const end = index + length;
            if (isWordChar(text[end])) continue;
            if (!withinDistance(text.slice(index, end), needle, max)) continue;
            const candidate = { start: index, end };
            if (existing.some((range) => candidate.start < range.end && candidate.end > range.start)) break;
            if (found.some((range) => candidate.start < range.end && candidate.end > range.start)) break;
            found.push(candidate);
            break;
        }
        if (found.length >= MAX_MATCHES_PER_TERM_LINE) break;
    }
    return found;
}

function isWholeWord(text: string, range: Range): boolean {
    return !isWordChar(text[range.start - 1]) && !isWordChar(text[range.end]);
}

function collectMatches(text: string, term: LeafTerm, options: SearchOptions, limit: number): Range[] {
    if (term.regex) {
        if (!term.pattern) return [];
        const flags = term.pattern.flags.includes('g') ? term.pattern.flags : `${term.pattern.flags}g`;
        const regex = new RegExp(term.pattern.source, flags);
        const ranges: Range[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) && ranges.length < limit) {
            if (!match[0].length) {
                regex.lastIndex += 1;
                continue;
            }
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        return ranges;
    }

    const needle = term.text;
    if (!needle) return [];
    const ranges: Range[] = [];

    if (term.wildcard) {
        const prefix = needle;
        let from = 0;
        while (ranges.length < limit) {
            const index = text.indexOf(prefix, from);
            if (index < 0) break;
            if (!isWordChar(text[index - 1])) {
                let end = index + prefix.length;
                while (end < text.length && isWordChar(text[end])) end += 1;
                ranges.push({ start: index, end });
            }
            from = index + prefix.length;
        }
    } else {
        let from = 0;
        while (ranges.length < limit) {
            const index = text.indexOf(needle, from);
            if (index < 0) break;
            ranges.push({ start: index, end: index + needle.length });
            from = index + Math.max(1, needle.length);
        }
        if (options.fuzzy > 0 && !needle.includes(' ')) {
            ranges.push(...fuzzyMatches(text, needle, options.fuzzy, ranges));
            ranges.sort((a, b) => a.start - b.start);
        }
    }

    const unique: Range[] = [];
    for (const range of ranges) {
        if (options.wholeWord && !isWholeWord(text, range)) continue;
        if (unique.some((item) => item.start === range.start && item.end === range.end)) continue;
        unique.push(range);
        if (unique.length >= limit) break;
    }
    return unique;
}

function mergeRanges(ranges: Range[]): Range[] {
    if (!ranges.length) return [];
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Range[] = [sorted[0]];
    for (const range of sorted.slice(1)) {
        const last = merged[merged.length - 1];
        if (range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

function inlinePlain(value: string): string {
    return value
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[\^[^\]\n]+\]/g, ' ')
        .replace(/\(¬\s*[\d\u06F0-\u06F9\u0660-\u0669]+\)/g, ' ')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)([^*_]+)\1/g, '$2')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/==(.*?)==/g, '$1')
        .replace(/^[>|]+\s*/g, '')
        .replace(/¬/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

interface SnippetBuild {
    text: string;
    ranges: SearchSnippetRange[];
}

function buildSnippet(original: string, line: NormalizedLine, ranges: Range[], radius: number): SnippetBuild | null {
    if (!ranges.length || !original) return null;
    const firstOrig = line.map[ranges[0].start];
    const lastOrig = line.map[ranges[ranges.length - 1].end - 1];
    if (firstOrig === undefined || lastOrig === undefined) return null;

    let start = Math.max(0, firstOrig - radius);
    if (start > 0) {
        const floor = Math.max(0, firstOrig - radius - 48);
        while (start > floor && !/\s/.test(original[start])) start -= 1;
        if (/\s/.test(original[start])) start += 1;
    }

    let end = Math.min(original.length, lastOrig + 1 + radius);
    if (end < original.length) {
        const ceiling = Math.min(original.length, lastOrig + 1 + radius + 48);
        while (end < ceiling && !/\s/.test(original[end])) end += 1;
    }

    const slice = original.slice(start, end);
    if (!slice.trim()) return null;
    const prefix = start > 0 ? '…' : '';
    const suffix = end < original.length ? '…' : '';
    const text = `${prefix}${slice}${suffix}`;

    const output: SearchSnippetRange[] = [];
    for (const range of ranges) {
        const rangeStart = line.map[range.start];
        const rangeEnd = line.map[range.end - 1];
        if (rangeStart === undefined || rangeEnd === undefined) continue;
        const from = rangeStart - start + prefix.length;
        const to = rangeEnd + 1 - start + prefix.length;
        if (to <= 0 || from >= text.length) continue;
        output.push({ start: Math.max(0, from), end: Math.min(text.length, to) });
    }
    if (!output.length) return null;
    return { text, ranges: output };
}

function metaValue(value: unknown): string {
    if (Array.isArray(value)) return value.map((item) => String(item)).join(' ');
    return value == null ? '' : String(value);
}

function matchesFields(book: BookSummary, fields: SearchQueryField[], caseSensitive: boolean): boolean {
    if (!fields.length) return true;
    const meta = book.frontmatter;
    const haystack: Record<SearchField, string> = {
        title: normalizeTerm(metaValue(meta['نام کتاب']) || book.filename, caseSensitive),
        author: normalizeTerm(metaValue(meta['نویسنده']), caseSensitive),
        translator: normalizeTerm(metaValue(meta['مترجم']), caseSensitive),
        section: normalizeTerm(metaValue(meta['بخش']), caseSensitive),
        tag: normalizeTerm(metaValue(meta['برچسب ها']), caseSensitive),
        folder: normalizeTerm(book.filename.replace(/\/[^/]*$/, ''), caseSensitive)
    };

    for (const field of fields) {
        const needle = normalizeTerm(field.value, caseSensitive);
        if (!needle) continue;
        const hit = haystack[field.field].includes(needle);
        if (field.negative ? hit : !hit) return false;
    }
    return true;
}

function foldForPresence(value: string, caseSensitive: boolean): string {
    let output = '';
    let previousSpace = false;
    for (let index = 0; index < value.length; index += 1) {
        const folded = foldChar(value[index]);
        if (!folded) continue;
        const piece = caseSensitive ? folded : folded.toLowerCase();
        for (const unit of piece) {
            if (/\s/.test(unit)) {
                if (previousSpace) continue;
                previousSpace = true;
                output += ' ';
            } else {
                previousSpace = false;
                output += unit;
            }
        }
    }
    return output;
}

/** Cheap whole-page gate so books/pages without any candidate term skip the expensive line scan. */
function pageHasCandidate(
    text: string,
    terms: LeafTerm[],
    options: SearchOptions,
    requireAll: boolean
): boolean {
    const folded = foldForPresence(text, options.caseSensitive);
    let found = 0;
    for (const term of terms) {
        let hit = false;
        if (term.regex) {
            if (term.pattern) {
                const flags = term.pattern.flags.includes('g') ? term.pattern.flags : `${term.pattern.flags}g`;
                hit = new RegExp(term.pattern.source, flags).test(folded);
            }
        } else if (term.text) {
            hit = folded.includes(term.text);
        }
        if (hit) {
            found += 1;
            if (!requireAll) return true;
        } else if (requireAll) {
            return false;
        }
    }
    return requireAll ? found >= terms.length : found > 0;
}

function pageLabelOf(pageIndex: number, marker: string): string {
    if (marker) return marker;
    const digits = String(pageIndex + 1).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
    return `صفحه ${digits}`;
}

export function searchBook(
    book: BookSummary,
    content: string,
    rawQuery: string,
    options: SearchOptions
): SearchBookResult | null {
    const parsed = parseQuery(rawQuery, options);
    if (parsed.error || (!parsed.terms.length && !parsed.fields.length)) return null;
    if (!matchesFields(book, parsed.fields, options.caseSensitive)) return null;

    const positive = parsed.terms.filter((term) => !term.negative);
    const negative = parsed.terms.filter((term) => term.negative);
    if (!positive.length) return null;
    const requireAll = options.mode === 'all' && !parsed.anyMode;

    const meta = book.frontmatter;
    const title = metaValue(meta['نام کتاب']) || book.filename;
    const author = metaValue(meta['نویسنده']);
    const section = metaValue(meta['بخش']);
    const folder = book.filename.includes('/') ? book.filename.slice(0, book.filename.lastIndexOf('/')) : '';

    const normalizedTitle = normalizeTerm(title, options.caseSensitive);
    const normalizedAuthor = normalizeTerm(author, options.caseSensitive);
    const pages: SearchPageHit[] = [];
    let totalMatches = 0;
    let heading = '';

    for (const page of bookSearchPages(content)) {
        if (options.fuzzy === 0) {
            const pageText = options.includeFootnotes ? `${page.body}\n${page.footnotes.join('\n')}` : page.body;
            if (!pageHasCandidate(pageText, positive, options, requireAll)) continue;
        }

        const blocks: { text: string; kind: SearchSnippetKind }[] = [];
        if (page.body.trim()) {
            for (const line of page.body.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === '---') continue;
                blocks.push({ text: trimmed, kind: /^#{1,6}\s+/.test(trimmed) ? 'heading' : 'text' });
            }
        }
        if (options.includeFootnotes) {
            for (const line of page.footnotes) {
                if (line.trim()) blocks.push({ text: line.trim(), kind: 'footnote' });
            }
        }

        const counters = new Map<number, number>();
        const snippets: SearchSnippet[] = [];
        const pageTermHits = new Set<number>();
        let pageMatches = 0;
        const inheritedHeading = heading;
        let firstHeading = '';
        let pageHeading = heading;

        for (let lineIndex = 0; lineIndex < blocks.length; lineIndex += 1) {
            const block = blocks[lineIndex];
            const headingMatch = block.text.match(/^(#{1,6})\s+(.*)$/);
            if (headingMatch) {
                pageHeading = inlinePlain(headingMatch[2]) || pageHeading;
                if (!firstHeading) firstHeading = pageHeading;
            }
            if (block.kind === 'heading' && !options.includeHeadings) continue;
            if (options.headingsOnly && block.kind !== 'heading') continue;

            const plain = inlinePlain(headingMatch ? headingMatch[2] : block.text);
            if (!plain) continue;
            const normalized = normalizeLine(plain, options.caseSensitive);
            if (!normalized.text) continue;

            if (
                negative.length &&
                negative.some((term) => collectMatches(normalized.text, term, options, 1).length > 0)
            ) {
                continue;
            }

            const perTerm = new Map<number, Range[]>();
            for (let termIndex = 0; termIndex < positive.length; termIndex += 1) {
                const ranges = collectMatches(normalized.text, positive[termIndex], options, MAX_MATCHES_PER_TERM_LINE);
                if (ranges.length) perTerm.set(termIndex, ranges);
            }
            if (!perTerm.size) continue;

            const starts = new Map<number, number>();
            for (const [termIndex, ranges] of perTerm) {
                const start = counters.get(termIndex) ?? 0;
                starts.set(termIndex, start);
                counters.set(termIndex, start + ranges.length);
                pageTermHits.add(termIndex);
            }

            pageMatches += mergeRanges([...perTerm.values()].flat()).length;
            if (snippets.length >= MAX_SNIPPETS_PER_PAGE) continue;

            const primaryIndex = [...perTerm.keys()][0];
            const primary = positive[primaryIndex];
            const primaryRanges = perTerm.get(primaryIndex) ?? [];
            if (!primaryRanges.length) continue;

            const built = buildSnippet(plain, normalized, primaryRanges.slice(0, 3), 70);
            if (!built) continue;
            if (snippets.some((snippet) => snippet.text === built.text)) continue;

            snippets.push({
                text: built.text,
                ranges: built.ranges,
                occurrence: starts.get(primaryIndex) ?? 0,
                highlight: primary.text,
                term: primary.raw,
                kind: block.kind,
                line: lineIndex
            });
        }

        heading = pageHeading;
        // «همهٔ واژه‌ها» a page-level rule: the words may sit in different
        // paragraphs of the same page, so they are not required on one line.
        if (requireAll && pageTermHits.size < positive.length) continue;
        if (!pageMatches) continue;
        totalMatches += pageMatches;
        pages.push({
            pageIndex: page.index,
            pageLabel: pageLabelOf(page.index, page.marker),
            heading: firstHeading || inheritedHeading,
            matches: pageMatches,
            snippets
        });
    }

    if (!pages.length) return null;

    const searchable = [normalizeTerm(rawQuery, options.caseSensitive)];
    const titleBoost =
        normalizedTitle && searchable.some((value) => value && normalizedTitle.includes(value)) ? 40 : 0;
    const authorBoost =
        normalizedAuthor && searchable.some((value) => value && normalizedAuthor.includes(value)) ? 20 : 0;
    const score =
        totalMatches * 4 +
        pages.length * 6 +
        pages.reduce((sum, page) => sum + page.snippets.filter((snippet) => snippet.kind === 'heading').length * 5, 0) +
        titleBoost +
        authorBoost;

    return {
        filename: book.filename,
        title,
        author,
        section,
        folder,
        pages,
        pagesCount: pages.length,
        matches: totalMatches,
        score
    };
}

export function createEmptyOutcome(): SearchOutcome {
    return {
        results: [],
        matches: 0,
        pages: 0,
        books: 0,
        scanned: 0,
        candidates: 0,
        totalBooks: 0,
        tookMs: 0,
        error: '',
        terms: [],
        fields: [],
        running: false
    };
}

export function summarize(
    results: SearchBookResult[],
    params: {
        options: SearchOptions;
        scanned: number;
        candidates: number;
        totalBooks: number;
        tookMs: number;
        terms: string[];
        fields: SearchQueryField[];
        running: boolean;
        error?: string;
        indexing?: SearchIndexing;
    }
): SearchOutcome {
    const sorted = [...results].sort((a, b) => {
        if (params.options.sort === 'matches') return b.matches - a.matches || b.score - a.score;
        if (params.options.sort === 'title') return a.title.localeCompare(b.title, 'fa');
        return b.score - a.score || b.matches - a.matches;
    });

    return {
        results: sorted,
        matches: sorted.reduce((sum, result) => sum + result.matches, 0),
        pages: sorted.reduce((sum, result) => sum + result.pagesCount, 0),
        books: sorted.length,
        scanned: params.scanned,
        candidates: params.candidates,
        totalBooks: params.totalBooks,
        tookMs: Math.round(params.tookMs),
        error: params.error || '',
        terms: params.terms,
        fields: params.fields,
        running: params.running,
        indexing: params.indexing
    };
}

const CHAR_VARIANTS: Record<string, string[]> = {
    'ا': ['ا', 'أ', 'إ', 'آ', 'ٱ'],
    'ی': ['ی', 'ي', 'ى', 'ئ'],
    'ک': ['ک', 'ك'],
    'ه': ['ه', 'ة', 'ۀ'],
    'و': ['و', 'ؤ'],
    '0': ['0', '۰', '٠'],
    '1': ['1', '۱', '١'],
    '2': ['2', '۲', '٢'],
    '3': ['3', '۳', '٣'],
    '4': ['4', '۴', '٤'],
    '5': ['5', '۵', '٥'],
    '6': ['6', '۶', '٦'],
    '7': ['7', '۷', '٧'],
    '8': ['8', '۸', '٨'],
    '9': ['9', '۹', '٩']
};

function charPattern(char: string): string {
    const variants = CHAR_VARIANTS[char];
    const base = variants ? `[${variants.map(escapeRegex).join('')}]` : escapeRegex(char);
    return `${base}[\\u064B-\\u0652\\u0670\\u0640]*`;
}

/** Builds a highlight regex for the reader that tolerates Persian letter variants and diacritics. */
export function buildHighlightPattern(term: string): RegExp | null {
    const text = term.replace(/[\u200c\u200d]/g, ' ').trim();
    if (!text) return null;
    let source = '';
    for (const char of text) {
        if (/\s/.test(char)) {
            source += '[\\s\\u200c]+';
            continue;
        }
        source += charPattern(foldChar(char) || char);
    }
    try {
        return new RegExp(source, 'giu');
    } catch {
        try {
            return new RegExp(source, 'gi');
        } catch {
            return null;
        }
    }
}
