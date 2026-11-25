/**
 * Small helpers used by the library and search indexes. They keep disk work
 * bounded (a few files in flight) instead of opening thousands of handles at
 * once, and let long builds give the event loop a chance to serve requests.
 */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Runs `task` at most once while a previous run is still in flight. */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
    let running: Promise<T> | null = null;
    return () => {
        if (running) return running;
        running = task().finally(() => {
            running = null;
        });
        return running;
    };
}
