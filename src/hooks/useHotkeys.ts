import { useEffect } from 'react';

interface HotkeyMap {
    onSearch: () => void;
    onSearchPanel: () => void;
    onFilter: () => void;
    onSettings: () => void;
    onReport: () => void;
    onBatch: () => void;
    onRefresh: () => void;
    isBlocked: () => boolean;
}

export function useHotkeys(handlers: HotkeyMap): void {
    useEffect(() => {
        const listener = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.tagName === 'SELECT' ||
                    target.isContentEditable)
            ) {
                return;
            }
            if (handlers.isBlocked()) return;

            const key = event.key.toLowerCase();
            if (event.key === '/') {
                event.preventDefault();
                handlers.onSearch();
                return;
            }
            if (key === 'q') {
                event.preventDefault();
                handlers.onSearchPanel();
            } else if (key === 'f') {
                event.preventDefault();
                handlers.onFilter();
            } else if (key === 's') {
                event.preventDefault();
                handlers.onSettings();
            } else if (key === 'g') {
                event.preventDefault();
                handlers.onReport();
            } else if (key === 't') {
                event.preventDefault();
                handlers.onBatch();
            } else if (key === 'r') {
                event.preventDefault();
                handlers.onRefresh();
            }
        };
        window.addEventListener('keydown', listener);
        return () => window.removeEventListener('keydown', listener);
    }, [handlers]);
}
