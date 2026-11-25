import { useRef, useState } from 'react';
import { cn, faNumber } from '../../lib/format';
import { Icon } from '../icons';
import { Button, Field, TextInput } from '../ui/Controls';
import { Modal } from '../ui/Modal';

interface AddBookDialogProps {
    open: boolean;
    folders: string[];
    onClose: () => void;
    onAddBook: (folder: string, filename: string, content: string) => Promise<void>;
    onCreateFolder: (parent: string, name: string) => Promise<string>;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

type Tab = 'files' | 'paste';

export function AddBookDialog({
    open,
    folders,
    onClose,
    onAddBook,
    onCreateFolder,
    notify
}: AddBookDialogProps) {
    const [tab, setTab] = useState<Tab>('files');
    const [folder, setFolder] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [results, setResults] = useState<{ name: string; ok: boolean; message?: string }[]>([]);
    const [pasteName, setPasteName] = useState('');
    const [pasteContent, setPasteContent] = useState('');
    const [folderName, setFolderName] = useState('');
    const [creatingFolder, setCreatingFolder] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const reset = () => {
        setFiles([]);
        setResults([]);
        setPasteName('');
        setPasteContent('');
        setFolderName('');
        setBusy(false);
    };

    const close = () => {
        if (busy) return;
        reset();
        onClose();
    };

    const createFolder = async () => {
        if (!folderName.trim()) {
            notify('نام پوشه را وارد کنید.', 'error');
            return;
        }
        setCreatingFolder(true);
        try {
            const path = await onCreateFolder(folder, folderName.trim());
            setFolder(path);
            setFolderName('');
            notify('پوشهٔ تازه ساخته شد.');
        } catch (error) {
            notify(error instanceof Error ? error.message : 'ساخت پوشه انجام نشد.', 'error');
        } finally {
            setCreatingFolder(false);
        }
    };

    const addFiles = (list: FileList | File[]) => {
        const incoming = Array.from(list).filter((file) => file.name.toLowerCase().endsWith('.md'));
        if (!incoming.length) {
            notify('فقط فایل‌های Markdown با پسوند md. پذیرفته می‌شوند.', 'error');
            return;
        }
        setFiles((current) => {
            const names = new Set(current.map((file) => file.name));
            return [...current, ...incoming.filter((file) => !names.has(file.name))];
        });
        setResults([]);
    };

    const upload = async () => {
        if (!files.length) {
            notify('ابتدا یک یا چند فایل Markdown انتخاب کنید.', 'error');
            return;
        }
        setBusy(true);
        const collected: { name: string; ok: boolean; message?: string }[] = [];
        for (const file of files) {
            try {
                await onAddBook(folder, file.name, await file.text());
                collected.push({ name: file.name, ok: true });
            } catch (error) {
                collected.push({
                    name: file.name,
                    ok: false,
                    message: error instanceof Error ? error.message : 'افزودن انجام نشد.'
                });
            }
            setResults([...collected]);
        }
        setBusy(false);
        const added = collected.filter((item) => item.ok).length;
        if (added) {
            notify(
                added === collected.length
                    ? `${faNumber(added)} کتاب به کتابخانه افزوده شد.`
                    : `${faNumber(added)} کتاب افزوده شد؛ ${faNumber(collected.length - added)} فایل ناموفق بود.`,
                added === collected.length ? 'success' : 'info'
            );
            setFiles([]);
            if (added === collected.length) {
                reset();
                onClose();
            }
        } else {
            notify('کتابی افزوده نشد؛ نام تکراری یا محتوای فایل نامعتبر است.', 'error');
        }
    };

    const savePaste = async () => {
        const name = pasteName.trim() || 'کتاب-تازه.md';
        const filename = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
        if (!pasteContent.trim()) {
            notify('متن کتاب را وارد کنید.', 'error');
            return;
        }
        setBusy(true);
        try {
            await onAddBook(folder, filename, pasteContent);
            notify('کتاب تازه به کتابخانه افزوده شد.');
            reset();
            onClose();
        } catch (error) {
            notify(error instanceof Error ? error.message : 'افزودن کتاب انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={open}
            title="افزودن کتاب به کتابخانه"
            kicker="ورود کتاب تازه"
            icon="plus"
            size="lg"
            onClose={close}
            footer={
                <>
                    <Button variant="soft" size="sm" onClick={close} disabled={busy}>
                        انصراف
                    </Button>
                    {tab === 'files' ? (
                        <Button variant="primary" size="sm" icon="upload" disabled={busy || !files.length} onClick={() => void upload()}>
                            {busy ? 'در حال افزودن…' : 'افزودن فایل‌ها'}
                        </Button>
                    ) : (
                        <Button variant="primary" size="sm" icon="save" disabled={busy} onClick={() => void savePaste()}>
                            {busy ? 'در حال ذخیره…' : 'ذخیرهٔ کتاب'}
                        </Button>
                    )}
                </>
            }
        >
            <div className="add-book">
                <div className="add-book__top">
                    <div className="tabs">
                        <button
                            type="button"
                            className={cn('tab', tab === 'files' && 'is-active')}
                            onClick={() => setTab('files')}
                        >
                            <Icon name="upload" size={15} /> انتخاب فایل
                        </button>
                        <button
                            type="button"
                            className={cn('tab', tab === 'paste' && 'is-active')}
                            onClick={() => setTab('paste')}
                        >
                            <Icon name="edit" size={15} /> نوشتن یا چسباندن
                        </button>
                    </div>
                    <Field label="ذخیره در" className="add-book__folder">
                        <select className="input select" value={folder} onChange={(event) => setFolder(event.target.value)}>
                            <option value="">قفسهٔ اصلی</option>
                            {folders.map((item) => (
                                <option key={item} value={item}>
                                    {item}
                                </option>
                            ))}
                        </select>
                    </Field>
                </div>

                {tab === 'files' ? (
                    <>
                        <div
                            className={cn('dropzone', dragging && 'is-dragging')}
                            onDragOver={(event) => {
                                event.preventDefault();
                                setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(event) => {
                                event.preventDefault();
                                setDragging(false);
                                addFiles(event.dataTransfer.files);
                            }}
                            onClick={() => fileInput.current?.click()}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(event) => event.key === 'Enter' && fileInput.current?.click()}
                        >
                            <span className="dropzone__icon">
                                <Icon name="upload" size={24} />
                            </span>
                            <strong>فایل‌های Markdown را اینجا رها کنید</strong>
                            <small>یا کلیک کنید تا از رایانه انتخاب شود — چند فایل پشتیبانی می‌شود</small>
                            <input
                                ref={fileInput}
                                type="file"
                                accept=".md,text/markdown"
                                multiple
                                hidden
                                onChange={(event) => event.target.files && addFiles(event.target.files)}
                            />
                        </div>

                        {files.length ? (
                            <div className="selected-files">
                                <div className="selected-files__head">
                                    <span>{faNumber(files.length)} فایل انتخاب شده</span>
                                    <button type="button" onClick={() => setFiles([])}>
                                        پاک‌کردن فهرست
                                    </button>
                                </div>
                                {files.map((file) => (
                                    <div key={file.name} className="selected-file">
                                        <Icon name="file" size={14} />
                                        <span dir="ltr">{file.name}</span>
                                        <em>{(file.size / 1024).toFixed(0)} KB</em>
                                        <button
                                            type="button"
                                            onClick={() => setFiles((current) => current.filter((item) => item.name !== file.name))}
                                            aria-label={`حذف ${file.name}`}
                                        >
                                            ×
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        {results.length ? (
                            <div className="import-results">
                                {results.map((result) => (
                                    <div key={result.name} className={cn('import-result', result.ok ? 'is-ok' : 'is-error')}>
                                        <Icon name={result.ok ? 'check' : 'alert'} size={14} />
                                        <span dir="ltr">{result.name}</span>
                                        <em>{result.ok ? 'افزوده شد' : result.message}</em>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </>
                ) : (
                    <div className="paste-book">
                        <Field label="نام فایل کتاب" hint="پسوند md. به‌طور خودکار اضافه می‌شود.">
                            <TextInput
                                value={pasteName}
                                placeholder="مثلاً: منتخب حکایت‌ها"
                                onChange={(event) => setPasteName(event.target.value)}
                            />
                        </Field>
                        <Field label="محتوای Markdown">
                            <textarea
                                className="input textarea textarea--tall"
                                value={pasteContent}
                                placeholder={'# عنوان کتاب\n\nمتن کتاب را اینجا بنویسید…'}
                                onChange={(event) => setPasteContent(event.target.value)}
                            />
                        </Field>
                    </div>
                )}

                <div className="add-book__new-folder">
                    <span className="add-book__new-folder-label">
                        <Icon name="folder" size={14} /> پوشهٔ تازه بسازید
                    </span>
                    <div className="add-book__new-folder-row">
                        <TextInput
                            value={folderName}
                            placeholder="نام پوشهٔ جدید"
                            onChange={(event) => setFolderName(event.target.value)}
                            onKeyDown={(event) => event.key === 'Enter' && void createFolder()}
                        />
                        <Button variant="soft" size="sm" icon="plus" disabled={creatingFolder} onClick={() => void createFolder()}>
                            ایجاد
                        </Button>
                    </div>
                    <small>پوشه داخل محل انتخاب‌شده ساخته می‌شود و بلافاصله انتخاب خواهد شد.</small>
                </div>
            </div>
        </Modal>
    );
}
