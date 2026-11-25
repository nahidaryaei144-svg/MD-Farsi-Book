import type { ReactNode, SVGProps } from 'react';

export type IconName =
    | 'book'
    | 'books'
    | 'search'
    | 'filter'
    | 'settings'
    | 'chart'
    | 'tools'
    | 'plus'
    | 'refresh'
    | 'sun'
    | 'moon'
    | 'palette'
    | 'close'
    | 'minus'
    | 'maximize'
    | 'restore'
    | 'chevron'
    | 'star'
    | 'check'
    | 'folder'
    | 'tag'
    | 'user'
    | 'globe'
    | 'edit'
    | 'copy'
    | 'arrowLeft'
    | 'arrowUp'
    | 'arrowDown'
    | 'grid'
    | 'list'
    | 'download'
    | 'upload'
    | 'trash'
    | 'save'
    | 'sparkles'
    | 'alert'
    | 'clock'
    | 'file'
    | 'link'
    | 'type'
    | 'zoomIn'
    | 'zoomOut'
    | 'expand'
    | 'pin'
    | 'menu'
    | 'info'
    | 'layers'
    | 'external'
    | 'shield'
    | 'bolt'
    | 'wifiOff'
    | 'quote'
    | 'bookmark'
    | 'eye'
    | 'panelLeft';

const paths: Record<IconName, ReactNode> = {
    book: (
        <>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </>
    ),
    books: (
        <>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M9 6h7M9 10h5" />
        </>
    ),
    search: (
        <>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </>
    ),
    filter: <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />,
    settings: (
        <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1.11 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 20.95 10H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
        </>
    ),
    chart: (
        <>
            <path d="M3 3v18h18" />
            <path d="M7 16v-4M12 16V8M17 16v-7" />
        </>
    ),
    tools: (
        <>
            <path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4z" />
        </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
        <>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </>
    ),
    sun: (
        <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
        </>
    ),
    moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
    palette: (
        <>
            <path d="M12 3a9 9 0 1 0 0 18c1.7 0 2-1.2 1.2-2.2-.9-1.1-.2-2.8 1.3-2.8H18a3 3 0 0 0 3-3c0-5-4-10-9-10z" />
            <circle cx="7.5" cy="11.5" r="1" />
            <circle cx="10" cy="7" r="1" />
            <circle cx="15" cy="7.5" r="1" />
            <circle cx="17.5" cy="11" r="1" />
        </>
    ),
    close: <path d="M18 6 6 18M6 6l12 12" />,
    minus: <path d="M5 12h14" />,
    maximize: <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />,
    restore: (
        <>
            <path d="M8 8V3H3M16 8V3h5M8 16v5H3M16 16v5h5" />
        </>
    ),
    chevron: <path d="m6 9 6 6 6-6" />,
    star: <path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z" />,
    check: <path d="m4 12.5 5 5L20 6.5" />,
    folder: (
        <>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </>
    ),
    tag: (
        <>
            <path d="M20.6 13.4 12 22l-9-9 8.6-8.6A2 2 0 0 1 13 4h6a2 2 0 0 1 2 2v6a2 2 0 0 1-.4 1.4z" />
            <circle cx="16.5" cy="7.5" r="1.2" />
        </>
    ),
    user: (
        <>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
        </>
    ),
    globe: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </>
    ),
    edit: (
        <>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </>
    ),
    copy: (
        <>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
    ),
    arrowLeft: <path d="M19 12H5M12 19l-7-7 7-7" />,
    arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
    arrowDown: <path d="M12 5v14M5 12l7 7 7-7" />,
    grid: (
        <>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </>
    ),
    list: (
        <>
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6h.01M3 12h.01M3 18h.01" />
        </>
    ),
    download: (
        <>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M7 10l5 5 5-5M12 15V3" />
        </>
    ),
    upload: (
        <>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5M12 3v12" />
        </>
    ),
    trash: (
        <>
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            <path d="M10 11v5M14 11v5" />
        </>
    ),
    save: (
        <>
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <path d="M17 21v-8H7v8M7 3v5h8" />
        </>
    ),
    sparkles: (
        <>
            <path d="m12 3 1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
            <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
        </>
    ),
    alert: (
        <>
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            <path d="M12 9v4M12 17h.01" />
        </>
    ),
    clock: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
        </>
    ),
    file: (
        <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M9 13h6M9 17h4" />
        </>
    ),
    link: (
        <>
            <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
            <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
        </>
    ),
    type: <path d="M4 7V5h16v2M9 19h6M12 5v14" />,
    zoomIn: (
        <>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5M8 11h6M11 8v6" />
        </>
    ),
    zoomOut: (
        <>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5M8 11h6" />
        </>
    ),
    expand: <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />,
    pin: (
        <>
            <path d="M12 17v5M9 3h6l-1 7 4 4H6l4-4-1-7z" />
        </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    info: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
        </>
    ),
    layers: (
        <>
            <path d="m12 2 9 5-9 5-9-5 9-5z" />
            <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
        </>
    ),
    external: (
        <>
            <path d="M15 3h6v6M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </>
    ),
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    bolt: <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />,
    wifiOff: (
        <>
            <path d="m2 2 20 20" />
            <path d="M8.5 8.5A11 11 0 0 1 21 9M5 12.5a11 11 0 0 1 4-2.4M2 9a15 15 0 0 1 4.2-2.2M12 20h.01" />
        </>
    ),
    quote: (
        <>
            <path d="M7 7h4v5c0 3-2 5-4 6M15 7h4v5c0 3-2 5-4 6" />
        </>
    ),
    bookmark: <path d="M6 3h12v18l-6-4-6 4V3z" />,
    eye: (
        <>
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
        </>
    ),
    panelLeft: (
        <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
        </>
    )
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
    name: IconName;
    size?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.8, ...rest }: IconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            {...rest}
        >
            {paths[name]}
        </svg>
    );
}
