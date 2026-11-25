import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/format';
import type { PanelLayout } from '../../types';
import { Icon, type IconName } from '../icons';
import { IconButton } from '../ui/Controls';

interface FloatingPanelProps {
    title: string;
    subtitle?: string;
    icon: IconName;
    layout: PanelLayout;
    zIndex: number;
    footer?: ReactNode;
    className?: string;
    onFocus: () => void;
    onClose: () => void;
    onMinimize: () => void;
    onToggleMaximize: () => void;
    onLayoutChange: (layout: PanelLayout) => void;
    children: ReactNode;
}

type DragMode = 'move' | 'resize';

interface DragState {
    mode: DragMode;
    dir?: string;
    startX: number;
    startY: number;
    layout: PanelLayout;
}

function clampLayout(next: PanelLayout): PanelLayout {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(next.width, 320), Math.max(320, viewportWidth - 16));
    const height = Math.min(Math.max(next.height, 240), Math.max(240, viewportHeight - 16));
    return {
        ...next,
        width,
        height,
        left: Math.min(Math.max(next.left, 8 - width + 180), Math.max(8, viewportWidth - 120)),
        top: Math.min(Math.max(next.top, 0), Math.max(0, viewportHeight - 72))
    };
}

export function FloatingPanel({
    title,
    subtitle,
    icon,
    layout,
    zIndex,
    footer,
    className,
    onFocus,
    onClose,
    onMinimize,
    onToggleMaximize,
    onLayoutChange,
    children
}: FloatingPanelProps) {
    const [preview, setPreview] = useState<PanelLayout | null>(null);
    const [interacting, setInteracting] = useState<DragMode | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const layoutChangeRef = useRef(onLayoutChange);
    layoutChangeRef.current = onLayoutChange;
    const previewRef = useRef<PanelLayout | null>(null);

    const current = preview ?? layout;

    const endDrag = useCallback(() => {
        const state = dragRef.current;
        if (state) {
            const finalLayout = previewRef.current ? clampLayout(previewRef.current) : state.layout;
            layoutChangeRef.current(finalLayout);
        }
        dragRef.current = null;
        previewRef.current = null;
        setPreview(null);
        setInteracting(null);
    }, []);

    useEffect(() => {
        const handleMove = (event: PointerEvent) => {
            const state = dragRef.current;
            if (!state) return;
            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            const next: PanelLayout = { ...state.layout };
            if (state.mode === 'move') {
                next.left = state.layout.left + dx;
                next.top = state.layout.top + dy;
            } else {
                const dir = state.dir || 'se';
                if (dir.includes('e')) next.width = state.layout.width + dx;
                if (dir.includes('s')) next.height = state.layout.height + dy;
                if (dir.includes('w')) {
                    next.width = state.layout.width - dx;
                    next.left = state.layout.left + dx;
                }
                if (dir.includes('n')) {
                    next.height = state.layout.height - dy;
                    next.top = state.layout.top + dy;
                }
            }
            const clamped = clampLayout(next);
            previewRef.current = clamped;
            setPreview(clamped);
        };

        const handleUp = () => endDrag();

        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleUp);
        return () => {
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleUp);
        };
    }, [endDrag]);

    const startDrag = (mode: DragMode, dir: string | undefined, event: React.PointerEvent) => {
        if (layout.maximized) return;
        if (event.button !== 0) return;
        event.preventDefault();
        onFocus();
        dragRef.current = {
            mode,
            dir,
            startX: event.clientX,
            startY: event.clientY,
            layout: { ...layout }
        };
        previewRef.current = { ...layout };
        setInteracting(mode);
    };

    const style = layout.maximized
        ? { zIndex }
        : {
              left: current.left,
              top: current.top,
              width: current.width,
              height: current.height,
              zIndex
          };

    return (
        <section
            className={cn(
                'floating-panel',
                layout.maximized && 'is-maximized',
                interacting === 'move' && 'is-dragging',
                interacting === 'resize' && 'is-resizing',
                className
            )}
            style={style}
            onPointerDown={onFocus}
            aria-label={title}
        >
            <header
                className="floating-panel__head"
                onPointerDown={(event) => {
                    if ((event.target as HTMLElement).closest('button')) return;
                    startDrag('move', undefined, event);
                }}
                onDoubleClick={(event) => {
                    if ((event.target as HTMLElement).closest('button')) return;
                    onToggleMaximize();
                }}
            >
                <span className="floating-panel__mark">
                    <Icon name={icon} size={18} />
                </span>
                <div className="floating-panel__titles">
                    {subtitle ? <span className="floating-panel__eyebrow">{subtitle}</span> : null}
                    <h2>{title}</h2>
                </div>
                <div className="floating-panel__controls" onPointerDown={(event) => event.stopPropagation()}>
                    <IconButton icon="minus" label="کوچک کردن پنل" size={16} onClick={onMinimize} />
                    <IconButton
                        icon={layout.maximized ? 'restore' : 'maximize'}
                        label={layout.maximized ? 'بازگردانی اندازه' : 'بزرگ کردن پنل'}
                        size={15}
                        onClick={onToggleMaximize}
                    />
                    <IconButton icon="close" label="بستن پنل" size={16} onClick={onClose} />
                </div>
            </header>

            <div className="floating-panel__body">{children}</div>
            {footer ? <footer className="floating-panel__footer">{footer}</footer> : null}

            {!layout.maximized ? (
                <>
                    <span className="resize-handle resize-handle--n" onPointerDown={(event) => startDrag('resize', 'n', event)} />
                    <span className="resize-handle resize-handle--s" onPointerDown={(event) => startDrag('resize', 's', event)} />
                    <span className="resize-handle resize-handle--e" onPointerDown={(event) => startDrag('resize', 'e', event)} />
                    <span className="resize-handle resize-handle--w" onPointerDown={(event) => startDrag('resize', 'w', event)} />
                    <span className="resize-handle resize-handle--ne" onPointerDown={(event) => startDrag('resize', 'ne', event)} />
                    <span className="resize-handle resize-handle--nw" onPointerDown={(event) => startDrag('resize', 'nw', event)} />
                    <span className="resize-handle resize-handle--se" onPointerDown={(event) => startDrag('resize', 'se', event)} />
                    <span className="resize-handle resize-handle--sw" onPointerDown={(event) => startDrag('resize', 'sw', event)} />
                </>
            ) : null}
        </section>
    );
}
