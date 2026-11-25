import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { DataLocationInfo } from '../../types';
import { Icon } from '../icons';
import { Button, Field, TextInput, Toggle } from '../ui/Controls';
import { Modal } from '../ui/Modal';

interface DataFolderSectionProps {
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

export function DataFolderSection({ notify }: DataFolderSectionProps) {
    const [info, setInfo] = useState<DataLocationInfo | null>(null);
    const [pathDraft, setPathDraft] = useState('');
    const [move, setMove] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pendingRestart, setPendingRestart] = useState('');

    const load = useCallback(async () => {
        try {
            const payload = await api.location();
            setInfo(payload);
            setPathDraft((current) => current || payload.root);
        } catch {
            /* the panel still works with a typed path when the API is busy */
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const apply = async () => {
        const target = pathDraft.trim();
        if (!target) {
            notify('مسیر پوشهٔ داده را وارد کنید.', 'error');
            return;
        }
        setBusy(true);
        try {
            const result = await api.setLocation(target, move);
            setConfirming(false);
            setPendingRestart(result.root);
            notify(
                move
                    ? 'داده‌ها به پوشهٔ تازه منتقل شد. برای اعمال، برنامه را ببندید و دوباره باز کنید.'
                    : 'مسیر پوشهٔ داده ذخیره شد. برای اعمال، برنامه را ببندید و دوباره باز کنید.',
                'success'
            );
        } catch (error) {
            notify(error instanceof Error ? error.message : 'تغییر پوشهٔ داده انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="settings-section" aria-label="پوشهٔ دادهٔ برنامه">
            <h3 className="settings-section__title">
                <Icon name="folder" size={16} /> پوشهٔ دادهٔ برنامه
            </h3>
            <p className="settings-section__description">
                کتاب‌ها، تنظیمات و پوشهٔ سابقه (نسخه‌های پشتیبان) در این پوشه نگهداری می‌شوند. اگر می‌خواهید داده‌ها
                جای دیگری باشند، مسیر تازه را بنویسید.
            </p>

            <p className="library-path" title={info?.root || ''}>
                <Icon name="folder" size={14} />
                <span dir="ltr">{info?.root || '—'}</span>
            </p>

            <Field label="مسیر پوشهٔ تازه" hint="مسیر کامل پوشه، مثل D:\\Ketabkhane">
                <TextInput
                    dir="ltr"
                    value={pathDraft}
                    placeholder="D:\Ketabkhane"
                    onChange={(event) => setPathDraft(event.target.value)}
                />
            </Field>

            <Toggle
                checked={move}
                onChange={setMove}
                label="انتقال همهٔ داده‌ها به پوشهٔ تازه"
                hint="با روشن‌بودن، کتاب‌ها، تنظیمات و پوشهٔ سابقهٔ پشتیبان‌ها به پوشهٔ تازه منتقل می‌شوند. با خاموش‌بودن هیچ فایلی جابه‌جا نمی‌شود."
            />

            <div className="settings-actions">
                <Button
                    variant="primary"
                    size="sm"
                    icon="folder"
                    disabled={busy}
                    onClick={() => setConfirming(true)}
                >
                    تغییر پوشهٔ داده
                </Button>
                <Button
                    variant="soft"
                    size="sm"
                    icon="restore"
                    disabled={busy || !info}
                    onClick={() => {
                        setPathDraft(info?.defaultRoot || '');
                        setMove(false);
                        setPendingRestart('');
                    }}
                >
                    مسیر پیش‌فرض
                </Button>
            </div>

            {pendingRestart ? (
                <p className="data-folder__note" role="status">
                    <Icon name="info" size={14} />
                    <span>
                        مسیر تازه ذخیره شد: <bdi dir="ltr">{pendingRestart}</bdi> — برنامه را ببندید و دوباره باز کنید.
                    </span>
                </p>
            ) : null}

            <Modal
                open={confirming}
                title="تغییر پوشهٔ داده"
                kicker="تأیید عملیات"
                icon="folder"
                size="sm"
                onClose={() => setConfirming(false)}
                footer={
                    <>
                        <Button variant="soft" size="sm" onClick={() => setConfirming(false)}>
                            انصراف
                        </Button>
                        <Button variant="primary" size="sm" icon="folder" disabled={busy} onClick={() => void apply()}>
                            {busy ? 'در حال انجام…' : 'تأیید و ذخیره'}
                        </Button>
                    </>
                }
            >
                <p className="confirm-text">
                    پوشهٔ دادهٔ برنامه به مسیر <bdi dir="ltr">{pathDraft.trim() || '—'}</bdi> تغییر می‌کند.
                </p>
                <p className="confirm-text">
                    {move
                        ? 'همهٔ کتاب‌ها، تنظیمات و پوشهٔ سابقهٔ پشتیبان‌ها از جای فعلی به این پوشه منتقل می‌شوند و پوشهٔ قبلی خالی می‌ماند.'
                        : 'هیچ فایلی جابه‌جا نمی‌شود؛ پوشهٔ فعلی دست‌نخورده می‌ماند و برنامه از این به بعد همین پوشهٔ تازه را می‌خواند.'}
                </p>
                <p className="confirm-text">اعمال کامل تغییر، پس از بستن و باز کردن دوبارهٔ برنامه انجام می‌شود.</p>
            </Modal>
        </section>
    );
}
