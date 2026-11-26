/* Persian post-processing pipeline for translated book prose.
   Applies safe orthographic normalization (ي/ك -> ی/ک, standard ZWNJ rules,
   and Persian punctuation spacing) while leaving Markdown structure, code,
   URLs, placeholders ⟦N⟧, HTML tags, and {...} Arabic quotes intact. */

const PERSIAN_TARGET_RE = /^(?:fa(?:[-_][a-z0-9]+)?|persian|farsi|فارسی)$/i;

export function isPersianTarget(target: string): boolean {
    return PERSIAN_TARGET_RE.test(target.trim());
}

const PERSIAN_LETTER = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیئ';
const PREFIX_MI_RE = new RegExp(
    `(^|[\\s(\\[«"'*_>])(ن?می)[ \\t]+([${PERSIAN_LETTER}]{2,})`,
    'g'
);
const SUFFIX_HA_TER_RE = new RegExp(
    `(^|[\\s(\\[«"'*_>])(?!(?:از|در|با|به|تا|بر|بی|که|را|یا|هم|آن|این|چه|هر|یک|دو|سه|چند|پس|اگر|ولی|اما|نیز|حتی)[ \\t])([${PERSIAN_LETTER}]{2,})[ \\t]+(های?(?:ی|یم|یت|یش|یمان|یتان|یشان)?|ترین|تر)(?=$|[\\s.,،؛:؟!»)\\]}*_])`,
    'g'
);
const PAST_PARTICIPLE_SUFFIX_RE = new RegExp(
    `([${PERSIAN_LETTER}]+ه)[ \\t]+(ام|ای|ایم|اید|اند)(?=$|[\\s.,،؛:؟!»)\\]}*_])`,
    'g'
);

const PROTECTED_RE =
    /```[\s\S]*?```|`[^`\n]+`|⟦\s*\d+\s*⟧|<!--[\s\S]*?-->|<\/?[a-zA-Z][^>\n]*>|\]\([^)\n]+\)|https?:\/\/[^\s<>)\]]+|\{[^}\n]*[\u0600-\u06FF][^}\n]*\}/g;

export function normalizeTranslation(value: string, target: string): string {
    if (!value || !isPersianTarget(target)) return value;

    const held: string[] = [];
    const masked = value.replace(PROTECTED_RE, (match) => {
        const token = `\uE000P${held.length}\uE001`;
        held.push(match);
        return token;
    });

    let out = masked
        /* Normalize Arabic Yeh & Kaf to standard Persian */
        .replace(/\u064A/g, 'ی')
        .replace(/\u0649/g, 'ی')
        .replace(/\u0643/g, 'ک')
        /* Clean redundant spaces around existing ZWNJ */
        .replace(/[ \t]*\u200C[ \t]*/g, '\u200C')
        .replace(/\u200C{2,}/g, '\u200C');

    /* Standard ZWNJ rules (only in plain prose outside protected spans) */
    out = out.replace(PREFIX_MI_RE, '$1$2\u200C$3');
    out = out.replace(SUFFIX_HA_TER_RE, '$1$2\u200C$3');
    out = out.replace(PAST_PARTICIPLE_SUFFIX_RE, '$1\u200C$2');

    /* Persian comma/question mark adjacent to RTL prose + clean space before punctuation */
    out = out
        .replace(/([\u0600-\u06FF»)])[ \t]*,(?!\d)/g, '$1،')
        .replace(/([\u0600-\u06FF»)])[ \t]*\?/g, '$1؟')
        .replace(/([\u0600-\u06FF\d»)\]])[ \t]+([،؛؟!])/g, '$1$2')
        .replace(/([،؛؟])([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیئA-Za-z])/g, '$1 $2');

    return out.replace(/\uE000P(\d+)\uE001/g, (_, idx: string) => held[Number(idx)] ?? '');
}
