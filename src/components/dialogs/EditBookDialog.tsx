import { useEffect, useState } from 'react';
import type { BookMetadata, BookSummary } from '../../types';
import { Icon } from '../icons';
import { Button, Field, Rating, TagInput, TextInput } from '../ui/Controls';
import { Modal } from '../ui/Modal';

interface EditBookDialogProps {
    book: BookSummary | null;
    onClose: () => void;
    onSave: (book: BookSummary, metadata: BookMetadata) => Promise<void>;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

export function EditBookDialog({ book, onClose, onSave, notify }: EditBookDialogProps) {
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [translator, setTranslator] = useState('');
    const [section, setSection] = useState('');
    const [volume, setVolume] = useState('');
    const [volumeCount, setVolumeCount] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [rating, setRating] = useState(0);
    const [read, setRead] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!book) return;
        const meta = book.frontmatter;
        setTitle(meta['نام کتاب'] || '');
        setAuthor(meta['نویسنده'] || '');
        setTranslator(meta['مترجم'] || '');
        setSection(meta['بخش'] || '');
        setVolume(String(meta['جلد'] ?? ''));
        setVolumeCount(meta['تعداد جلدها'] ? String(meta['تعداد جلدها']) : '');
        setTags(Array.isArray(meta['برچسب ها']) ? meta['برچسب ها'] : []);
        setRating(Number(meta['امتیاز']) || 0);
        setRead(meta['خوانده شده'] === true);
    }, [book]);

    const save = async () => {
        if (!book) return;
        if (!title.trim()) {
            notify('نام کتاب نمی‌تواند خالی باشد.', 'error');
            return;
        }
        setBusy(true);
        try {
            await onSave(book, {
                ...book.frontmatter,
                'نام کتاب': title.trim(),
                'نویسنده': author.trim(),
                'مترجم': translator.trim(),
                'بخش': section.trim(),
                'جلد': volume.trim(),
                'تعداد جلدها': Number(volumeCount) > 0 ? Math.round(Number(volumeCount)) : undefined,
                'برچسب ها': tags,
                'امتیاز': rating,
                'خوانده شده': read
            });
            notify('مشخصات کتاب ذخیره شد.');
            onClose();
        } catch (error) {
            notify(error instanceof Error ? error.message : 'ذخیرهٔ مشخصات انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={Boolean(book)}
            title="ویرایش مشخصات کتاب"
            kicker={book ? book.filename : ''}
            icon="edit"
            size="md"
            onClose={onClose}
            footer={
                <>
                    <Button variant="soft" size="sm" onClick={onClose} disabled={busy}>
                        انصراف
                    </Button>
                    <Button variant="primary" size="sm" icon="save" disabled={busy} onClick={() => void save()}>
                        {busy ? 'در حال ذخیره…' : 'ذخیرهٔ تغییرات'}
                    </Button>
                </>
            }
        >
            <div className="edit-book">
                <div className="edit-book__grid">
                    <Field label="نام کتاب" className="edit-book__wide">
                        <TextInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="نام کتاب" />
                    </Field>
                    <Field label="نویسنده">
                        <TextInput value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="نام نویسنده" />
                    </Field>
                    <Field label="مترجم">
                        <TextInput value={translator} onChange={(event) => setTranslator(event.target.value)} placeholder="نام مترجم" />
                    </Field>
                    <Field label="موضوع / بخش">
                        <TextInput value={section} onChange={(event) => setSection(event.target.value)} placeholder="مثلاً تفسیر" />
                    </Field>
                    <Field label="جلد" hint="شمارهٔ همین جلد؛ خالی بگذارید اگر کتاب تک‌جلدی است.">
                        <TextInput value={volume} onChange={(event) => setVolume(event.target.value)} placeholder="مثلاً ۲" />
                    </Field>
                    <Field label="تعداد جلدها" hint="شماره کل جلدهای این کتاب.">
                        <TextInput
                            type="number"
                            min={0}
                            max={9999}
                            value={volumeCount}
                            onChange={(event) => setVolumeCount(event.target.value)}
                            placeholder="مثلاً ۱۲"
                        />
                    </Field>
                    <div className="edit-book__rating">
                        <span className="field__label">امتیاز کتاب</span>
                        <Rating value={rating} onChange={setRating} size={22} />
                        <small>{rating ? `${rating} ستاره` : 'بدون امتیاز'}</small>
                    </div>
                </div>

                <Field label="برچسب‌ها" hint="هر برچسب را بنویسید و Enter بزنید.">
                    <TagInput tags={tags} onChange={setTags} />
                </Field>

                <label className={`read-toggle ${read ? 'is-on' : ''}`}>
                    <input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} />
                    <span className="read-toggle__box">{read ? <Icon name="check" size={13} /> : null}</span>
                    <span>
                        <strong>این کتاب را خوانده‌ام</strong>
                        <small>برای پیگیری پیشرفت مطالعه در گزارش کتابخانه</small>
                    </span>
                </label>
            </div>
        </Modal>
    );
}
