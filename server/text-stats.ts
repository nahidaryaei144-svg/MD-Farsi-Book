/** Text measurements shared by the report and the content index, so a book is
    only ever scanned once for statistics. Strips HTML tags, anchors, and
    duplicate `.bi-orig` blocks on bilingual books so counts are accurate. */

const PAGE_MARKER_GLOBAL =
    /(?:^|\n)[ \t]*(?:بخش\s*:\s*[\d\u06F0-\u06F9]+(?:\s*-\s*صفحه\s*:\s*[\d\u06F0-\u06F9]+)?|الجزء\s*:|صفحه\s*:)/g;

function findBalancedSpanClose(text: string, openEnd: number): number {
    const tagRe = /<span\b[^>]*>|<\/span>/gi;
    tagRe.lastIndex = openEnd;
    let depth = 1;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(text)) !== null) {
        if (match[0].startsWith('</')) {
            depth -= 1;
            if (depth === 0) return match.index + match[0].length;
        } else {
            depth += 1;
        }
    }
    return -1;
}

function stripBilingualOrigBlocks(text: string): string {
    if (!/<span\b[^>]*\bbi-trans\b/i.test(text) || !/<span\b[^>]*\bbi-orig\b/i.test(text)) {
        return text;
    }
    const openRe = /<span\b[^>]*\bclass\s*=\s*(?:"[^"]*\bbi-orig\b[^"]*"|'[^']*\bbi-orig\b[^']*')[^>]*>/gi;
    let out = '';
    let cursor = 0;
    while (cursor < text.length) {
        openRe.lastIndex = cursor;
        const match = openRe.exec(text);
        if (!match) {
            out += text.slice(cursor);
            break;
        }
        out += text.slice(cursor, match.index);
        const closeEnd = findBalancedSpanClose(text, match.index + match[0].length);
        if (closeEnd < 0) {
            out += text.slice(match.index);
            break;
        }
        out += ' ';
        cursor = closeEnd;
    }
    return out;
}

export function stripMarkupForStats(text: string, start = 0): string {
    if (text.indexOf('<', start) < 0) {
        return start === 0 ? text : text.slice(start);
    }
    const slice = start === 0 ? text : text.slice(start);
    return stripBilingualOrigBlocks(slice)
        .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ');
}

export function measureText(text: string, start = 0): { words: number; characters: number } {
    const clean = stripMarkupForStats(text, start);
    let words = 0;
    let characters = 0;
    let inWord = false;
    for (let index = 0; index < clean.length; index += 1) {
        const code = clean.charCodeAt(index);
        if (
            code === 32 ||
            code === 9 ||
            code === 10 ||
            code === 13 ||
            code === 11 ||
            code === 12 ||
            code === 0x00a0
        ) {
            inWord = false;
            continue;
        }
        characters += 1;
        if (!inWord) {
            inWord = true;
            words += 1;
        }
    }
    return { words, characters };
}

export function countPages(text: string, start = 0): number {
    let pages = 0;
    PAGE_MARKER_GLOBAL.lastIndex = Math.max(0, start - 1);
    while (PAGE_MARKER_GLOBAL.exec(text) !== null) pages += 1;
    PAGE_MARKER_GLOBAL.lastIndex = 0;
    return pages;
}
