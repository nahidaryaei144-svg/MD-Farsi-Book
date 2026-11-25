import { createPortal } from 'react-dom';
import type { Toast } from '../../hooks/useToasts';
import { Icon } from '../icons';

interface ToastStackProps {
    toasts: Toast[];
    onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
    if (!toasts.length) return null;
    return createPortal(
        <div className="toast-stack" aria-live="polite" aria-atomic="false">
            {toasts.map((toast) => (
                <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
                    <span className="toast__icon">
                        <Icon
                            name={toast.tone === 'error' ? 'alert' : toast.tone === 'info' ? 'info' : 'check'}
                            size={17}
                        />
                    </span>
                    <span className="toast__text">{toast.message}</span>
                    <button
                        type="button"
                        className="toast__close"
                        onClick={() => onDismiss(toast.id)}
                        aria-label="بستن پیام"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>,
        document.body
    );
}
