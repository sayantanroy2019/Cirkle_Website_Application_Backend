import { defineConfig } from 'vitest/config';

// This is an integration suite, not a unit suite: every test talks to the
// live Supabase instance and most image tests round-trip through S3. Vitest's
// 5s default is a unit-test budget and was marginal here — several tests sat
// at 4-5s and failed intermittently under parallel load, looking like real
// failures when they were only slow.
//
// 30s is generous enough that a timeout means something is genuinely wrong
// (a hung connection, a stuck lock) rather than a slow round trip.
// hookTimeout is higher still: setup hooks bcrypt-hash several passwords and
// seed rows, and all 12 test files run in parallel against a single Supabase
// pooler, so the slowest setup contends with 11 others.
// Worker concurrency is capped because every test file opens its own pg pool
// against one shared Supabase pooler. Unbounded parallelism (one worker per
// core) starved connections badly enough that ordinary queries blocked past
// the 30s timeout — surfacing as random failures in a different test each run,
// never a real assertion failure. Four workers keeps most of the wall-clock
// win without the contention.
export default defineConfig({
    test: {
        testTimeout: 30000,
        hookTimeout: 60000,
        maxWorkers: 4,
        minWorkers: 1
    }
});
