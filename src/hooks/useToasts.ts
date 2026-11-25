import { useCallback, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
    id: number;
    message: string;
    tone: ToastTone;
}

export function useToasts() {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const counter = useRef(0);

    const removeToast = useCallback((id: number) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }, []);

    const notify = useCallback(
        (message: string, tone: ToastTone = 'success') => {
            counter.current += 1;
            const id = counter.current;
            setToasts((current) => [...current.slice(-3), { id, message, tone }]);
            setTimeout(() => removeToast(id), tone === 'error' ? 5200 : 3600);
        },
        [removeToast]
    );

    return { toasts, notify, removeToast };
}
