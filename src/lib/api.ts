import type {
    BatchMetadataChanges,
    BatchMetadataResult,
    BatchReplaceOptions,
    BatchReplaceResult,
    BilingualDisplayMode,
    BookContentPayload,
    BookMetadata,
    DataLocationInfo,
    ExportFormat,
    GeminiPlan,
    GlossaryDiscoveryResult,
    LibraryPayload,
    LibraryReport,
    PanelId,
    PanelLayout,
    QueuedBookJob,
    RelocateResult,
    SearchOptions,
    SearchStreamEvent,
    Snapshot,
    TranslateConfigPayload,
    TranslateConfigPublic,
    TranslateEngineId,
    TranslationEstimate,
    TranslationJob,
    TranslationMode,
    TranslationPresetId,
    TranslationPreviewResult,
    TranslationUsage
} from '../types';

async function request<T>(
    url: string,
    init: RequestInit = {},
    cache: RequestCache = 'no-store'
): Promise<T> {
    const response = await fetch(url, {
        ...init,
        headers: {
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {})
        },
        cache
    });

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message =
            payload && typeof payload === 'object' && 'error' in payload
                ? String((payload as { error: unknown }).error)
                : 'درخواست به سرور انجام نشد.';
        throw new Error(message);
    }
    return payload as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
    return request<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
    library: () => request<LibraryPayload>('/api/library', {}, 'default'),

    /**
     * Streams a full-text search from the server. Each event carries the hits
     * found so far, so results appear while the remaining books are checked.
     */
    searchLibrary: async (
        body: { query: string; options: SearchOptions; filenames?: string[] },
        onEvent: (event: SearchStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<void> => {
        const response = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
            cache: 'no-store'
        });

        if (!response.ok) {
            let message = 'جست‌وجو انجام نشد.';
            try {
                const payload = (await response.json()) as { error?: unknown };
                if (payload && typeof payload.error === 'string') message = payload.error;
            } catch {
                // keep the generic message
            }
            throw new Error(message);
        }
        if (!response.body) throw new Error('جست‌وجوی زنده در دسترس نیست.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const emit = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                onEvent(JSON.parse(trimmed) as SearchStreamEvent);
            } catch {
                // A partial or malformed line is ignored; the stream continues.
            }
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                emit(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
            }
        }
        buffer += decoder.decode();
        emit(buffer);
    },

    content: (filename: string) =>
        request<BookContentPayload>(`/api/books/content?filename=${encodeURIComponent(filename)}`),

    saveBook: (filename: string, frontmatter: BookMetadata) =>
        post<{ success: boolean; frontmatter: BookMetadata }>('/api/save-book', {
            filename,
            frontmatter
        }),

    saveContent: (filename: string, content: string, revision: string) =>
        post<{ success: boolean; revision: string; frontmatter: BookMetadata }>('/api/save-content', {
            filename,
            content,
            revision
        }),

    addBook: (folder: string, filename: string, content: string) =>
        post<{ success: boolean; filename: string }>('/api/add-book', {
            folder,
            filename,
            content
        }),

    createFolder: (parent: string, name: string) =>
        post<{ success: boolean; path: string }>('/api/create-folder', { parent, name }),

    settings: () =>
        request<{
            panelLayouts: Partial<Record<PanelId, PanelLayout>>;
            panelStyle: { cornerRadius?: number };
            panels?: Partial<Record<PanelId, { open: boolean; minimized: boolean }>>;
        }>('/api/settings'),

    savePanelLayout: (panel: PanelId, layout: PanelLayout) =>
        post<{ success: boolean }>('/api/settings', { panel, layout }),

    savePanelStyle: (cornerRadius: number) =>
        post<{ success: boolean }>('/api/settings', { panelStyle: { cornerRadius } }),

    savePanelsState: (panels: Partial<Record<PanelId, { open: boolean; minimized: boolean }>>) =>
        post<{ success: boolean }>('/api/settings', { panels }),

    report: () => request<LibraryReport>('/api/report'),

    snapshots: () => request<{ snapshots: Snapshot[] }>('/api/snapshots'),

    createSnapshot: () => post<{ success: boolean; snapshot: Snapshot }>('/api/snapshot', {}),

    restoreSnapshot: (id: string) =>
        post<{ success: boolean; restored: number; safety: string }>('/api/restore-snapshot', { id }),

    deleteSnapshot: (id: string) => post<{ success: boolean; id: string }>('/api/delete-snapshot', { id }),

    batchMetadata: (files: string[], changes: BatchMetadataChanges, dryRun: boolean) =>
        post<BatchMetadataResult>('/api/batch-metadata', { files, changes, dryRun }),

    batchReplace: (
        files: string[],
        search: string,
        replace: string,
        options: BatchReplaceOptions,
        dryRun: boolean
    ) =>
        post<BatchReplaceResult>('/api/batch-replace', {
            files,
            search,
            replace,
            options,
            dryRun
        }),

    translationSnapshot: (filename: string) =>
        post<{ success: boolean; snapshot: Snapshot }>('/api/translation-snapshot', { filename }),

    translateConfig: () => request<TranslateConfigPayload>('/api/translate/config'),

    saveTranslateConfig: (config: {
        engine: TranslateEngineId;
        endpoint: string;
        model: string;
        apiKey?: string;
        clearApiKey?: boolean;
        geminiPlan?: GeminiPlan;
        preset?: TranslationPresetId;
        prompt: string;
        rules: string;
        fmRules: string;
        glossary: string;
        concurrency: number;
        order: 'page' | 'structured';
        bilingual?: boolean;
    }) =>
        post<{ success: boolean; config: TranslateConfigPublic }>('/api/translate/config', config),

    translateEstimate: (
        filename: string,
        target: string,
        force: boolean,
        mode: TranslationMode = 'translate',
        pageRange?: string
    ) =>
        post<TranslationEstimate>('/api/translate/estimate', {
            filename,
            target,
            force,
            mode,
            ...(pageRange ? { pageRange } : {})
        }),

    translatePreview: (filename: string, target: string, page = 1) =>
        post<TranslationPreviewResult>('/api/translate/preview', { filename, target, page }),

    translateDiscoverGlossary: (filename: string, target: string, saveToConfig = false) =>
        post<GlossaryDiscoveryResult>('/api/translate/discover-glossary', {
            filename,
            target,
            saveToConfig
        }),

    translateSegment: (text: string, target = 'fa') =>
        post<{ translated: string; qaOk: boolean; qaIssue?: string; usage: TranslationUsage }>(
            '/api/translate/segment',
            { text, target }
        ),

    translateTmUpdate: (source: string, translated: string, target = 'fa') =>
        post<{ saved: boolean }>('/api/translate/tm-update', { source, translated, target }),

    translateQueueList: () => request<{ queue: QueuedBookJob[] }>('/api/translate/queue'),

    translateQueueAdd: (
        items: Array<{
            filename: string;
            target?: string;
            mode?: TranslationMode;
            bilingual?: boolean;
            force?: boolean;
            markTranslator?: boolean;
            pageRange?: string;
            autoGlossary?: boolean;
        }>
    ) =>
        post<{ success: boolean; queue: QueuedBookJob[]; startedImmediately: boolean }>(
            '/api/translate/queue',
            { items }
        ),

    translateQueueRemove: (id: string) =>
        post<{ success: boolean; queue: QueuedBookJob[] }>('/api/translate/queue/remove', { id }),

    translateQueueClear: () =>
        post<{ success: boolean; queue: QueuedBookJob[] }>('/api/translate/queue/clear', {}),

    translateStart: (
        filename: string,
        target: string,
        options: {
            force: boolean;
            markTranslator: boolean;
            mode: TranslationMode;
            bilingual?: boolean;
            pageRange?: string;
            autoGlossary?: boolean;
        }
    ) =>
        post<{ success: boolean; job: TranslationJob }>('/api/translate/start', {
            filename,
            target,
            ...options
        }),

    translateTest: () =>
        post<{
            ok: boolean;
            engine: string;
            engineLabel: string;
            model: string;
            milliseconds: number;
            sample: string;
        }>('/api/translate/test', {}),

    translateStatus: () =>
        request<{ job: TranslationJob | null; queue?: QueuedBookJob[] }>('/api/translate/status'),

    translatePause: () => post<{ success: boolean; job: TranslationJob | null }>('/api/translate/pause', {}),

    translateResume: () => post<{ success: boolean; job: TranslationJob | null }>('/api/translate/resume', {}),

    translateCancel: () => post<{ success: boolean; job: TranslationJob | null }>('/api/translate/cancel', {}),

    exportUrl: (filename: string, format: ExportFormat, display?: BilingualDisplayMode) =>
        `/api/export?format=${format}&filename=${encodeURIComponent(filename)}${
            display && display !== 'both' ? `&display=${encodeURIComponent(display)}` : ''
        }`,

    location: () => request<DataLocationInfo>('/api/location'),

    setLocation: (root: string, move: boolean) => post<RelocateResult>('/api/location', { root, move })
};
