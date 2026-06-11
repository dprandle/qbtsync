import { config } from "./config";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sliding-window rate limiter. QBT's live API rejects (HTTP 429) more than a
// fixed number of requests per rolling window; we self-throttle below that
// ceiling so we never trip it. A *sliding* window (not a fixed reset-every-N-ms
// counter) is required: a fixed window lets a full burst land at the end of one
// window and another at the start of the next, briefly doubling the rate over
// the boundary — which is exactly what QBT measures and rejects.
//
// The sync loop is single-threaded and sequential, but one tick can still burst
// (paginated fetches plus many per-entity mutations back-to-back), so acquire()
// blocks the caller until a slot frees up rather than dropping the request.
export class sliding_window_rate_limiter {
    // Epoch-ms timestamps of requests issued within the current window, oldest
    // first. Bounded by max_requests, so no unbounded growth.
    private hits: number[] = [];

    constructor(
        private readonly max_requests: number,
        private readonly window_ms: number
    ) {}

    async acquire(): Promise<void> {
        for (;;) {
            const now = Date.now();
            const cutoff = now - this.window_ms;
            // Evict requests that have aged out of the window.
            while (this.hits.length > 0 && this.hits[0] <= cutoff) {
                this.hits.shift();
            }
            if (this.hits.length < this.max_requests) {
                this.hits.push(now);
                return;
            }
            // At capacity: sleep until the oldest in-window request expires, then
            // re-check from the top (another caller may have taken the freed slot
            // while we slept). +1ms guards against waking a hair early.
            const wait_ms = this.hits[0] + this.window_ms - now + 1;
            wlog(
                `[qbt-rate-limit] At ${this.max_requests} req/${this.window_ms}ms cap — pausing ${wait_ms}ms`
            );
            await sleep(wait_ms);
        }
    }
}

// Shared across all QBT HTTP verbs so the cap applies to total API traffic.
export const qbt_rate_limiter = new sliding_window_rate_limiter(
    config.qbt_rate_limit_max_requests,
    config.qbt_rate_limit_window_ms
);
