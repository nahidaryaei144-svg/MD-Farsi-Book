/** Text measurements shared by the report and the content index, so a book is
    only ever scanned once for statistics. */

const PAGE_MARKER_GLOBAL =
    /(?:^|\n)[ \t]*(?:بخش\s*:\s*[\d\u06F0-\u06F9]+(?:\s*-\s*صفحه\s*:\s*[\d\u06F0-\u06F9]+)?|الجزء\s*:|صفحه\s*:)/g;

export function measureText(text: string, start = 0): { words: number; characters: number } {
    let words = 0;
    let characters = 0;
    let inWord = false;
    for (let index = start; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
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
