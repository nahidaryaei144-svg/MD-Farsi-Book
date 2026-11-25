import { cleanList, cleanValue, normalizeBookMetadata, parseFrontmatter, serializeBookFrontmatter } from './library.js';

interface FrontmatterEntry {
    key: string | null;
    lines: string[];
}

export interface MetadataChanges {
    setFields?: Record<string, string>;
    /** Text appended to a field instead of replacing it, e.g. author info. */
    appendFields?: Record<string, string>;
    addTags?: string[];
    removeTags?: string[];
    read?: boolean;
    rating?: number | string | null;
}

export interface ReplaceOptions {
    regex?: boolean;
    caseSensitive?: boolean;
    scope?: 'body' | 'metadata' | 'both';
}

function parseFrontmatterEntries(content: string): {
    entries: FrontmatterEntry[];
    rest: string;
    newline: string;
} | null {
    const text = String(content == null ? '' : content);
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const entries: FrontmatterEntry[] = [];
    let current: FrontmatterEntry | null = null;
    for (const line of match[1].split(/\r?\n/)) {
        const keyMatch = line.match(/^([^\s#-][^:]*):/);
        if (keyMatch) {
            current = { key: keyMatch[1].trim(), lines: [line] };
            entries.push(current);
        } else if (current) {
            current.lines.push(line);
        } else {
            entries.push({ key: null, lines: [line] });
        }
    }
    return {
        entries,
        rest: text.slice(match[0].length).replace(/^\r?\n/, ''),
        newline: text.includes('\r\n') ? '\r\n' : '\n'
    };
}

export function applyBookMetadataChanges(
    content: string,
    changes: MetadataChanges,
    filename = ''
): { content: string; changed: boolean } {
    const text = String(content == null ? '' : content);
    const parsed = parseFrontmatterEntries(text);
    const newline = parsed ? parsed.newline : text.includes('\r\n') ? '\r\n' : '\n';
    const metadata = normalizeBookMetadata(parseFrontmatter(text), filename);
    const setFields =
        changes.setFields && typeof changes.setFields === 'object' && !Array.isArray(changes.setFields)
            ? changes.setFields
            : {};

    for (const key of ['نام کتاب', 'نویسنده', 'معلومات نویسنده', 'مترجم', 'بخش', 'جلد', 'تعداد جلدها']) {
        const value = setFields[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        if (key === 'تعداد جلدها') {
            const count = Number(value);
            if (Number.isFinite(count) && count > 0) metadata[key] = Math.round(count);
            continue;
        }
        metadata[key] = value.trim();
    }

    /* Author information (and the other text fields) can be added to what a
       book already has, so a batch run never wipes an earlier note. */
    const appendFields =
        changes.appendFields && typeof changes.appendFields === 'object' && !Array.isArray(changes.appendFields)
            ? changes.appendFields
            : {};
    for (const key of ['معلومات نویسنده', 'نویسنده', 'مترجم', 'بخش', 'جلد']) {
        const addition = appendFields[key];
        if (typeof addition !== 'string' || !addition.trim()) continue;
        const text = addition.trim();
        const existing = String(metadata[key] ?? '').trim();
        if (!existing) metadata[key] = text;
        else if (!existing.includes(text)) metadata[key] = `${existing}\n${text}`;
    }

    const removals = new Set(cleanList(changes.removeTags).map((value) => value.toLocaleLowerCase()));
    metadata['برچسب ها'] = metadata['برچسب ها'].filter((tag) => !removals.has(tag.toLocaleLowerCase()));
    cleanList(changes.addTags).forEach((tag) => {
        if (!metadata['برچسب ها'].some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
            metadata['برچسب ها'].push(tag);
        }
    });
    if (typeof changes.read === 'boolean') metadata['خوانده شده'] = changes.read;
    if (Number.isFinite(Number(changes.rating)) && changes.rating !== null && changes.rating !== '') {
        metadata['امتیاز'] = Math.max(0, Math.min(5, Math.round(Number(changes.rating))));
    }

    const body = parsed ? parsed.rest : text.replace(/^\uFEFF/, '');
    const newContent = serializeBookFrontmatter(metadata, newline, filename) + body;
    return { content: newContent, changed: newContent !== text };
}

function escapeRegExp(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildReplacePattern(pattern: string, options: ReplaceOptions): RegExp {
    const flags = options.caseSensitive ? 'g' : 'gi';
    const source = options.regex ? pattern : escapeRegExp(pattern);
    return new RegExp(source, flags);
}

function firstMatchSnippet(text: string, search: string, options: ReplaceOptions): string {
    let probe: RegExp;
    try {
        probe = new RegExp(
            options.regex ? search : escapeRegExp(search),
            options.caseSensitive ? '' : 'i'
        );
    } catch {
        return '';
    }
    const index = text.search(probe);
    if (index < 0) return '';
    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + search.length + 60);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '… ' : '') + snippet + (end < text.length ? ' …' : '');
}

export function applyReplacement(
    content: string,
    search: string,
    replacement: string,
    options: ReplaceOptions
): {
    content: string;
    count: number;
    counts: { metadata: number; body: number };
    samples: string[];
} {
    const text = String(content == null ? '' : content);
    const scope = options.scope || 'both';
    const frontmatterMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
    const head = frontmatterMatch ? frontmatterMatch[0] : '';
    const body = frontmatterMatch ? text.slice(frontmatterMatch[0].length) : text;
    const counts = { metadata: 0, body: 0 };
    const samples: string[] = [];
    if (!search) return { content: text, count: 0, counts, samples };

    let regex: RegExp;
    try {
        regex = buildReplacePattern(search, options);
    } catch {
        return { content: text, count: 0, counts, samples };
    }

    const transform = (part: string): string => {
        const matches = part.match(regex);
        if (!matches) return part;
        if (samples.length < 2) {
            const snippet = firstMatchSnippet(part, search, options);
            if (snippet) samples.push(snippet);
        }
        return options.regex
            ? part.replace(regex, replacement)
            : part.replace(regex, () => replacement);
    };

    let newHead = head;
    let newBody = body;
    if (head && (scope === 'both' || scope === 'metadata')) {
        counts.metadata = (head.match(regex) || []).length;
        newHead = transform(head);
    }
    if (body && (scope === 'both' || scope === 'body')) {
        counts.body = (body.match(regex) || []).length;
        newBody = transform(body);
    }

    return { content: newHead + newBody, count: counts.metadata + counts.body, counts, samples };
}

export function cleanTagList(value: unknown): string[] {
    return cleanList(value).map((item) => cleanValue(item));
}
