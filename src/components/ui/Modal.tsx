import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/format';
import { Icon, type IconName } from '../icons';
import { IconButton } from './Controls';

interface ModalProps {
    open: boolean;
    title: string;
    kicker?: string;
    icon?: IconName;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    className?: string;
}

export function Modal({
    open,
    title,
    kicker,
    icon,
    size = 'md',
    onClose,
    children,
    footer,
    className
}: ModalProps) {
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousOverflow;
        };
    }, [open, onClose]);

    if (!open) return null;

    return createPortal(
        <div
            className="modal-layer"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className={cn('modal', `modal--${size}`, className)}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <header className="modal__head">
                    <div className="modal__title-wrap">
                        {icon ? (
                            <span className="modal__icon">
                                <Icon name={icon} size={19} />
                            </span>
                        ) : null}
                        <div>
                            {kicker ? <span className="modal__kicker">{kicker}</span> : null}
                            <h2 className="modal__title">{title}</h2>
                        </div>
                    </div>
                    <IconButton icon="close" label="بستن" onClick={onClose} />
                </header>
                <div className="modal__body">{children}</div>
                {footer ? <footer className="modal__footer">{footer}</footer> : null}
            </div>
        </div>,
        document.body
    );
}
