import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { faDateTime, faNumber } from '../../lib/format';
import type { Snapshot } from '../../types';
import { Icon } from '../icons';
import { Button, EmptyState } from '../ui/Controls';
import { Modal } from '../ui/Modal';

interface BackupsPanelProps {
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
    onRestored: () => Promise<void> | void;
}

const REASON_LABELS: Record<string, string> = {
    manual: 'دستی',
    'batch-metadata': 'ویرایش گروهی متادیتا',
    'batch-replace': 'جایگزینی گروهی',
    'before-restore': 'پیش از بازگردانی',
    'before-translation': 'پیش از ترجمه'
};

export function BackupsPanel({ notify, onRestored }: BackupsPanelProps) {
    const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<Snapshot | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Snapshot | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await api.snapshots();
            setSnapshots(result.snapshots);
        } catch (error) {
            notify(error instanceof Error ? error.message : 'فهرست نسخه‌ها خوانده نشد.', 'error');
        } finally {
            setLoading(false);
        }
    }, [notify]);

    useEffect(() => {
        void load();
    }, [load]);

    const create = async () => {
        setBusy(true);
        try {
            await api.createSnapshot();
            notify('نسخهٔ پشتیبان کامل کتابخانه ساخته شد.');
            await load();
        } catch (error) {
            notify(error instanceof Error ? error.message : 'ساخت نسخهٔ پشتیبان انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const restore = async () => {
        if (!pending) return;
        setBusy(true);
        try {
            const result = await api.restoreSnapshot(pending.id);
            notify(
                result.restored
                    ? `${faNumber(result.restored)} فایل بازگردانی شد. یک نسخهٔ ایمنی نیز ساخته شد.`
                    : 'چیزی برای بازگردانی پیدا نشد.'
            );
            setPending(null);
            await load();
            await onRestored();
        } catch (error) {
            notify(error instanceof Error ? error.message : 'بازگردانی انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!pendingDelete) return;
        setBusy(true);
        try {
            await api.deleteSnapshot(pendingDelete.id);
            notify('نسخهٔ پشتیبان حذف شد.', 'success');
            setPendingDelete(null);
            await load();
        } catch (error) {
            notify(error instanceof Error ? error.message : 'حذف نسخهٔ پشتیبان انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="backups-panel">
            <div className="backups-intro">
                <span className="backups-intro__icon">
                    <Icon name="shield" size={20} />
                </span>
                <div>
                    <strong>نسخه‌های ایمن کتابخانه</strong>
                    <p>
                        نسخه‌ها فقط با دکمهٔ «نسخهٔ تازه» یا هنگام بازگردانی و ترجمه ساخته می‌شوند؛ تغییرات گروهی دیگر
                        نسخهٔ خودکار نمی‌سازند.
                    </p>
                </div>
                <Button variant="primary" size="sm" icon="save" disabled={busy} onClick={() => void create()}>
                    نسخهٔ تازه
                </Button>
            </div>

            {loading ? (
                <div className="panel-loading">
                    <span className="spinner" />
                    <p>در حال خواندن نسخه‌ها…</p>
                </div>
            ) : snapshots.length ? (
                <div className="snapshot-list">
                    {snapshots.map((snapshot) => (
                        <div key={snapshot.id} className="snapshot-item">
                            <span className={`snapshot-item__icon ${snapshot.scope === 'book' ? 'is-book' : ''}`}>
                                <Icon name={snapshot.scope === 'book' ? 'file' : 'books'} size={17} />
                            </span>
                            <div className="snapshot-item__main">
                                <strong>
                                    {REASON_LABELS[snapshot.reason] || snapshot.reason}
                                    {snapshot.scope === 'book' ? ' — یک کتاب' : ''}
                                </strong>
                                <span className="snapshot-item__meta">
                                    <span>
                                        <Icon name="clock" size={12} /> {faDateTime(snapshot.createdAt)}
                                    </span>
                                    <span>
                                        <Icon name="file" size={12} /> {faNumber(snapshot.books)} فایل
                                    </span>
                                </span>
                                {snapshot.filename ? (
                                    <span className="snapshot-item__file" dir="ltr">
                                        {snapshot.filename}
                                    </span>
                                ) : null}
                            </div>
                            <div className="snapshot-item__actions">
                                <Button variant="ghost" size="sm" icon="restore" onClick={() => setPending(snapshot)}>
                                    بازگردانی
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    icon="trash"
                                    aria-label="حذف نسخهٔ پشتیبان"
                                    title="حذف نسخهٔ پشتیبان"
                                    onClick={() => setPendingDelete(snapshot)}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <EmptyState
                    icon="shield"
                    title="هنوز نسخه‌ای ساخته نشده"
                    description="با دکمهٔ «نسخهٔ تازه» یک نسخهٔ کامل و ایمن از کتابخانه بسازید."
                    action={<Button variant="primary" size="sm" icon="save" onClick={() => void create()}>ساخت نسخه</Button>}
                />
            )}

            <p className="backups-note">
                <Icon name="info" size={14} /> بازگردانی، قبل از جایگزینی فایل‌ها یک نسخهٔ ایمنی تازه می‌سازد؛ پس هیچ
                داده‌ای بی‌بازگشت از دست نمی‌رود. حذف نسخه، فقط همان پوشهٔ پشتیبان را پاک می‌کند و به کتاب‌ها کاری ندارد.
            </p>

            <Modal
                open={Boolean(pendingDelete)}
                title="حذف نسخهٔ پشتیبان"
                kicker="تأیید حذف"
                icon="trash"
                size="sm"
                onClose={() => setPendingDelete(null)}
                footer={
                    <>
                        <Button variant="soft" size="sm" onClick={() => setPendingDelete(null)}>
                            انصراف
                        </Button>
                        <Button variant="danger" size="sm" icon="trash" disabled={busy} onClick={() => void remove()}>
                            {busy ? 'در حال حذف…' : 'حذف کن'}
                        </Button>
                    </>
                }
            >
                <p className="confirm-text">
                    نسخهٔ <strong>{REASON_LABELS[pendingDelete?.reason || ''] || pendingDelete?.reason}</strong> از{' '}
                    {pendingDelete ? faDateTime(pendingDelete.createdAt) : ''} برای همیشه حذف می‌شود. فایل‌های کتابخانه دست
                    نمی‌خورند.
                </p>
            </Modal>

            <Modal
                open={Boolean(pending)}
                title="بازگردانی نسخهٔ پشتیبان"
                kicker="تأیید عملیات"
                icon="restore"
                size="sm"
                onClose={() => setPending(null)}
                footer={
                    <>
                        <Button variant="soft" size="sm" onClick={() => setPending(null)}>
                            انصراف
                        </Button>
                        <Button variant="primary" size="sm" icon="restore" disabled={busy} onClick={() => void restore()}>
                            {busy ? 'در حال بازگردانی…' : 'بازگردانی کن'}
                        </Button>
                    </>
                }
            >
                <p className="confirm-text">
                    فایل‌های کتابخانه با نسخهٔ <strong>{REASON_LABELS[pending?.reason || ''] || pending?.reason}</strong>{' '}
                    از {pending ? faDateTime(pending.createdAt) : ''} جایگزین می‌شوند. پیش از جایگزینی، یک نسخهٔ ایمنی
                    خودکار ساخته می‌شود.
                </p>
            </Modal>
        </div>
    );
}
