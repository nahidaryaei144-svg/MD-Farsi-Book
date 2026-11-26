export interface BookMetadata {
    'نام کتاب': string;
    'نویسنده': string;
    'مترجم': string;
    'بخش': string;
    'معلومات نویسنده'?: string;
    'جلد'?: string;
    'تعداد جلدها'?: number;
    'برچسب ها': string[];
    'امتیاز': number;
    'خوانده شده': boolean;
    [key: string]: unknown;
}

export interface BookSummary {
    filename: string;
    frontmatter: BookMetadata;
    size: number;
    modifiedAt: string;
    url: string;
}

export interface LibraryPayload {
    generatedAt: string;
    libraryDir: string;
    books: BookSummary[];
    folders: string[];
}

export interface BookContentPayload {
    filename: string;
    content: string;
    revision: string;
    frontmatter: BookMetadata;
}

export type SearchScope = 'books' | 'content' | 'toc';

export interface LibraryFilters {
    query: string;
    scope: SearchScope;
    sections: string[];
    folders: string[];
    authors: string[];
    tags: string[];
    favoritesOnly: boolean;
    readOnly: boolean;
    inFiltered: boolean;
}

export type PanelId = 'filter' | 'search' | 'settings' | 'report' | 'batch' | 'backups';

export interface PanelLayout {
    left: number;
    top: number;
    width: number;
    height: number;
    maximized: boolean;
}

export interface PanelState {
    open: boolean;
    minimized: boolean;
    layout: PanelLayout;
}

export type ThemeName = 'dark' | 'light' | 'sepia' | 'glass';

export interface PreferenceState {
    theme: ThemeName;
    font: string;
    zoom: number;
    cornerRadius: number;
}

export interface ReportTotals {
    books: number;
    folders: number;
    sections: number;
    authors: number;
    read: number;
    unread: number;
    favorites: number;
    withoutMetadata: number;
    missingMetadata: number;
    duplicates: number;
    words: number;
    characters: number;
    pages: number;
    bytes: number;
}

export interface LibraryReport {
    generatedAt: string;
    totals: ReportTotals;
    sections: { name: string; books: number; words: number }[];
    authors: { name: string; books: number; words: number }[];
    duplicates: { files: string[] }[];
    largest: { filename: string; title: string; words: number; pages: number; bytes: number }[];
    longest: { filename: string; title: string; words: number; pages: number; bytes: number }[];
    incomplete: { filename: string; title: string; missing: string[] }[];
    files: {
        filename: string;
        title: string;
        author: string;
        translator: string;
        section: string;
        tags: string[];
        rating: number;
        read: boolean;
        hasFrontmatter: boolean;
        words: number;
        characters: number;
        pages: number;
        bytes: number;
        modifiedAt: string;
        missing: string[];
    }[];
}

export type TranslationStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'error';
export type TranslationMode = 'translate' | 'review';
export type ExportFormat = 'md' | 'docx' | 'html' | 'pdf';

export type GeminiPlan = 'free' | 'paid';

export interface TranslationSample {
    source: string;
    translated: string;
}

export interface TranslationUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requests: number;
}

export interface TranslationJob {
    id: string;
    filename: string;
    title: string;
    target: string;
    targetLabel: string;
    mode: TranslationMode;
    engine: string;
    engineLabel: string;
    parallel: number;
    status: TranslationStatus;
    total: number;
    done: number;
    translated: number;
    cached: number;
    skipped: number;
    failed: number;
    inspected: number;
    repaired: number;
    characters: number;
    startedAt: string | null;
    finishedAt: string | null;
    updatedAt: string;
    snapshotId: string | null;
    revision: string | null;
    message: string;
    samples: TranslationSample[];
    speed: number;
    etaSeconds: number | null;
    bilingual?: boolean;
    pageRange?: string;
    usage?: TranslationUsage;
}

export interface TranslationEstimate {
    filename: string;
    target: string;
    targetLabel: string;
    mode: TranslationMode;
    engine: string;
    engineLabel: string;
    segments: number;
    candidates: number;
    cached: number;
    skipped: number;
    untranslated: number;
    suspicious: number;
    characters: number;
}

export interface TranslationPreviewItem {
    source: string;
    translated: string;
    qaOk: boolean;
    qaIssue?: string;
}

export interface TranslationPreviewResult {
    filename: string;
    title: string;
    page: number;
    totalPages: number;
    target: string;
    targetLabel: string;
    engine: string;
    engineLabel: string;
    items: TranslationPreviewItem[];
    usage: TranslationUsage;
}

export interface GlossaryDiscoveryResult {
    terms: string[];
    mergedCount: number;
    glossary: string;
    usage: TranslationUsage;
}

export interface QueuedBookJob {
    id: string;
    filename: string;
    title: string;
    target: string;
    targetLabel: string;
    mode: TranslationMode;
    bilingual?: boolean;
    force?: boolean;
    markTranslator?: boolean;
    pageRange?: string;
    autoGlossary?: boolean;
    addedAt: string;
}

export type TranslateEngineId = 'google' | 'libretranslate' | 'deepl' | 'gemini' | 'openai' | 'anthropic';
export type TranslationPresetId = 'islamic-ar-fa' | 'literary-general' | 'technical-academic' | 'custom';

export interface TranslationPreset {
    id: TranslationPresetId;
    label: string;
    description: string;
    prompt: string;
    rules: string;
    fmRules: string;
    glossary: string;
}

export interface TranslateEngineInfo {
    id: TranslateEngineId;
    label: string;
    hint: string;
    kind: 'machine' | 'ai';
    needsKey: boolean;
    needsEndpoint: boolean;
    needsModel: boolean;
}

export interface TranslateConfigPublic {
    engine: TranslateEngineId;
    endpoint: string;
    model: string;
    hasApiKey: boolean;
    geminiPlan?: GeminiPlan;
    preset?: TranslationPresetId;
    prompt: string;
    rules: string;
    fmRules: string;
    glossary: string;
    concurrency: number;
    order: 'page' | 'structured';
    bilingual: boolean;
}

export interface TranslateConfigPayload {
    config: TranslateConfigPublic;
    engines: TranslateEngineInfo[];
    presets?: TranslationPreset[];
}

export interface Snapshot {
    id: string;
    createdAt: string;
    reason: string;
    books: number;
    scope?: 'library' | 'book';
    filename?: string;
}

export interface DataLocationInfo {
    root: string;
    defaultRoot: string;
    libraryDir: string;
    storageDir: string;
    backupDir: string;
    configFile: string;
}

export interface RelocateResult {
    success: boolean;
    root: string;
    moved: string[];
    untouched: boolean;
    requiresRestart: boolean;
}

export type SearchMode = 'all' | 'any' | 'phrase' | 'regex';
export type SearchSort = 'relevance' | 'matches' | 'title';
export type SearchField = 'title' | 'author' | 'translator' | 'section' | 'tag' | 'folder';
export type SearchSnippetKind = 'text' | 'heading' | 'footnote';

export interface SearchQueryField {
    field: SearchField;
    value: string;
    negative: boolean;
}

export interface SearchOptions {
    mode: SearchMode;
    fuzzy: number;
    wholeWord: boolean;
    caseSensitive: boolean;
    includeHeadings: boolean;
    includeFootnotes: boolean;
    headingsOnly: boolean;
    sort: SearchSort;
}

export interface SearchSnippetRange {
    start: number;
    end: number;
}

export interface SearchSnippet {
    text: string;
    ranges: SearchSnippetRange[];
    occurrence: number;
    highlight: string;
    term: string;
    kind: SearchSnippetKind;
    line: number;
}

export interface SearchPageHit {
    pageIndex: number;
    pageLabel: string;
    heading: string;
    matches: number;
    snippets: SearchSnippet[];
}

export interface SearchBookResult {
    filename: string;
    title: string;
    author: string;
    section: string;
    folder: string;
    pages: SearchPageHit[];
    pagesCount: number;
    matches: number;
    score: number;
}

export interface SearchIndexing {
    total: number;
    indexed: number;
    running: boolean;
}

export interface SearchOutcome {
    results: SearchBookResult[];
    matches: number;
    pages: number;
    books: number;
    scanned: number;
    candidates: number;
    totalBooks: number;
    tookMs: number;
    error: string;
    terms: string[];
    fields: SearchQueryField[];
    running: boolean;
    indexing?: SearchIndexing;
}

type SearchStreamProgress = {
    scanned: number;
    candidates: number;
    totalBooks: number;
    tookMs: number;
};

/** Server-sent progress while a library-wide content search is running. */
export type SearchStreamEvent =
    | {
          type: 'meta';
          candidates: number;
          totalBooks: number;
          skipped: number;
          notIndexed: number;
          indexing: SearchIndexing;
          tookMs: number;
      }
    | ({ type: 'progress' } & SearchStreamProgress)
    | ({ type: 'results'; results: SearchBookResult[]; running: boolean } & SearchStreamProgress)
    | ({ type: 'done'; indexing: SearchIndexing } & SearchStreamProgress)
    | { type: 'error'; error: string };

export type SearchHitOpener = (result: SearchBookResult, page: SearchPageHit, snippet: SearchSnippet) => void;

export interface BatchMetadataChanges {
    setFields: Record<string, string>;
    appendFields?: Record<string, string>;
    addTags: string[];
    removeTags: string[];
    read?: boolean;
    rating?: number;
}

export interface BatchReplaceOptions {
    regex: boolean;
    caseSensitive: boolean;
    scope: 'body' | 'metadata' | 'both';
}

export interface BatchMetadataResult {
    success: boolean;
    dryRun: boolean;
    updated: number;
    files: string[];
    unchanged: number;
    failed: string[];
    snapshot: string | null;
}

export interface BatchReplaceResult {
    success: boolean;
    dryRun: boolean;
    totalMatches: number;
    updated: number;
    results: {
        filename: string;
        matches: number;
        metadata: number;
        body: number;
        samples: string[];
    }[];
    failed: string[];
    snapshot: string | null;
}

export type BilingualDisplayMode = 'both' | 'translated' | 'original';
export type BilingualBoxStyle = 'none' | 'subtle' | 'border' | 'card';
export type BilingualFontWeight = '400' | '500' | '700';

export interface BilingualSideStyle {
    color: string;
    fontSize: number;
    weight: BilingualFontWeight;
    opacity: number;
    font: string;
    italic: boolean;
    box: BilingualBoxStyle;
}

export interface BilingualSettings {
    display: BilingualDisplayMode;
    original: BilingualSideStyle;
    translated: BilingualSideStyle;
}
