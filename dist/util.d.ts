/** JSON.stringify with sorted keys, so hashes don't depend on key order. */
export declare function stableStringify(value: unknown): string;
export declare function sha256(value: unknown): string;
export declare const shortHash: (value: unknown) => string;
/** Read a dotted path ("answer.items.0.name") from a value. Empty path returns the value itself. */
export declare function getPath(value: unknown, path?: string): unknown;
/** Text view of an output for string graders: strings as-is, everything else as JSON. */
export declare function asText(value: unknown): string;
/** Replace "file://relative/path" strings (anywhere in the value) with the file's contents. */
export declare function resolveFileRefs<T>(value: T, baseDir: string): T;
export interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
/** Run a shell command, optionally piping `input` to stdin. Never throws on non-zero exit. */
export declare function runCommand(cmd: string, opts?: {
    cwd?: string;
    env?: Record<string, string>;
    input?: string;
    timeoutMs?: number;
}): Promise<CommandResult>;
/** Run async tasks with at most `limit` in flight. Results keep input order. */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
export declare function withTimeout<T>(promise: Promise<T>, ms: number | undefined, label: string): Promise<T>;
export declare class TimeoutError extends Error {
}
/** The environment failed (timeout, unreachable endpoint, HTTP 5xx). Retried, and never scored as FAIL. */
export declare class InfraError extends Error {
}
/** The code under test itself failed (non-zero exit, thrown exception, HTTP 4xx). Scored as FAIL, not retried. */
export declare class TargetError extends Error {
}
export declare const dirOf: (file: string) => string;
