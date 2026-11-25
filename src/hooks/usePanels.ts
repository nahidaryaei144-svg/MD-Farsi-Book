import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { PanelId, PanelLayout, PanelState } from '../types';
import { clamp } from '../lib/format';

const PANEL_IDS: PanelId[] = ['filter', 'search', 'settings', 'report', 'batch', 'backups'];

function viewport() {
    return {
        width: typeof window === 'undefined' ? 1440 : window.innerWidth,
        height: typeof window === 'undefined' ? 900 : window.innerHeight
    };
}

export function defaultLayout(id: PanelId): PanelLayout {
    const { width, height } = viewport();
    const top = 84;
    const maxHeight = Math.max(420, height - top - 60);
    if (id === 'filter') {
        return {
            left: Math.max(18, width - 468),
            top,
            width: Math.min(440, width - 36),
            height: Math.min(720, maxHeight),
            maximized: false
        };
    }
    if (id === 'search') {
        return {
            left: Math.max(18, (width - 1080) / 2),
            top,
            width: Math.min(1080, width - 36),
            height: Math.min(780, maxHeight),
            maximized: false
        };
    }
    if (id === 'settings') {
        return {
            left: Math.max(18, width - 900),
            top: Math.min(top + 26, height - 300),
            width: Math.min(440, width - 36),
            height: Math.min(760, maxHeight),
            maximized: false
        };
    }
    if (id === 'backups') {
        return {
            left: Math.max(18, (width - 760) / 2),
            top: Math.min(top + 20, height - 320),
            width: Math.min(760, width - 36),
            height: Math.min(620, maxHeight),
            maximized: false
        };
    }
    if (id === 'batch') {
        return {
            left: Math.max(18, (width - 1040) / 2),
            top,
            width: Math.min(1040, width - 36),
            height: Math.min(800, maxHeight),
            maximized: false
        };
    }
    return {
        left: Math.max(18, (width - 1120) / 2),
        top,
        width: Math.min(1120, width - 36),
        height: Math.min(820, maxHeight),
        maximized: false
    };
}

function defaultPanels(): Record<PanelId, PanelState> {
    return {
        filter: { open: false, minimized: false, layout: defaultLayout('filter') },
        search: { open: false, minimized: false, layout: defaultLayout('search') },
        settings: { open: false, minimized: false, layout: defaultLayout('settings') },
        report: { open: false, minimized: false, layout: defaultLayout('report') },
        batch: { open: false, minimized: false, layout: defaultLayout('batch') },
        backups: { open: false, minimized: false, layout: defaultLayout('backups') }
    };
}

export function usePanels() {
    const [panels, setPanels] = useState<Record<PanelId, PanelState>>(defaultPanels);
    const [order, setOrder] = useState<PanelId[]>([]);
    const [loaded, setLoaded] = useState(false);
    const saveTimers = useRef<Partial<Record<PanelId, ReturnType<typeof setTimeout>>>>({});
    const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        api.settings()
            .then((settings) => {
                setPanels((current) => {
                    const next = { ...current };
                    for (const id of PANEL_IDS) {
                        const saved = settings.panelLayouts?.[id];
                        const state = settings.panels?.[id];
                        next[id] = {
                            open: Boolean(state?.open),
                            minimized: Boolean(state?.minimized),
                            layout: saved
                                ? {
                                      ...saved,
                                      width: clamp(saved.width, 280, 4000),
                                      height: clamp(saved.height, 240, 4000)
                                  }
                                : current[id].layout
                        };
                    }
                    return next;
                });
                setOrder(
                    (['filter', 'search', 'settings', 'report', 'batch', 'backups'] as PanelId[]).filter(
                        (id) => settings.panels?.[id]?.open
                    )
                );
            })
            .catch(() => {})
            .finally(() => setLoaded(true));
    }, []);

    useEffect(() => {
        if (!loaded) return;
        if (stateTimer.current) clearTimeout(stateTimer.current);
        stateTimer.current = setTimeout(() => {
            const payload: Partial<Record<PanelId, { open: boolean; minimized: boolean }>> = {};
            for (const id of PANEL_IDS) {
                payload[id] = { open: panels[id].open, minimized: panels[id].minimized };
            }
            api.savePanelsState(payload).catch(() => {});
        }, 500);
    }, [panels, loaded]);

    const focusPanel = useCallback((id: PanelId) => {
        setOrder((current) => [...current.filter((item) => item !== id), id]);
    }, []);

    const openPanel = useCallback((id: PanelId) => {
        setPanels((current) => ({
            ...current,
            [id]: { ...current[id], open: true, minimized: false }
        }));
        focusPanel(id);
    }, [focusPanel]);

    const closePanel = useCallback((id: PanelId) => {
        setPanels((current) => ({ ...current, [id]: { ...current[id], open: false } }));
        setOrder((current) => current.filter((item) => item !== id));
    }, []);

    const togglePanel = useCallback((id: PanelId) => {
        setPanels((current) => {
            const nextOpen = !current[id].open;
            return {
                ...current,
                [id]: { ...current[id], open: nextOpen, minimized: nextOpen ? false : current[id].minimized }
            };
        });
        focusPanel(id);
    }, [focusPanel]);

    const minimizePanel = useCallback((id: PanelId) => {
        setPanels((current) => ({ ...current, [id]: { ...current[id], minimized: true } }));
    }, []);

    const restorePanel = useCallback((id: PanelId) => {
        setPanels((current) => ({
            ...current,
            [id]: { ...current[id], open: true, minimized: false }
        }));
        focusPanel(id);
    }, [focusPanel]);

    const toggleMaximize = useCallback((id: PanelId) => {
        setPanels((current) => ({
            ...current,
            [id]: {
                ...current[id],
                minimized: false,
                open: true,
                layout: { ...current[id].layout, maximized: !current[id].layout.maximized }
            }
        }));
        focusPanel(id);
    }, [focusPanel]);

    const updateLayout = useCallback((id: PanelId, layout: PanelLayout) => {
        setPanels((current) => ({ ...current, [id]: { ...current[id], layout } }));
        const timers = saveTimers.current;
        if (timers[id]) clearTimeout(timers[id]);
        timers[id] = setTimeout(() => {
            api.savePanelLayout(id, layout).catch(() => {});
        }, 400);
    }, []);

    const resetLayouts = useCallback(() => {
        setPanels((current) => {
            const next = { ...current };
            for (const id of PANEL_IDS) next[id] = { ...next[id], layout: defaultLayout(id) };
            return next;
        });
    }, []);

    useEffect(() => {
        const onResize = () => {
            setPanels((current) => {
                const { width, height } = viewport();
                const next = { ...current };
                for (const id of PANEL_IDS) {
                    const layout = current[id].layout;
                    next[id] = {
                        ...current[id],
                        layout: {
                            ...layout,
                            left: clamp(layout.left, 0, Math.max(0, width - 160)),
                            top: clamp(layout.top, 0, Math.max(0, height - 80)),
                            width: Math.min(layout.width, width - 16),
                            height: Math.min(layout.height, height - 16)
                        }
                    };
                }
                return next;
            });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const hasMinimized = PANEL_IDS.some((id) => panels[id].open && panels[id].minimized);
    const topPanel = order.length ? order[order.length - 1] : null;

    return {
        panels,
        order,
        hasMinimized,
        topPanel,
        loaded,
        openPanel,
        closePanel,
        togglePanel,
        minimizePanel,
        restorePanel,
        toggleMaximize,
        updateLayout,
        resetLayouts,
        focusPanel
    };
}
