import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** JSON.stringify with sorted keys, so hashes don't depend on key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function sha256(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(text).digest("hex");
}

export const shortHash = (value: unknown) => sha256(value).slice(0, 12);

/** Read a dotted path ("answer.items.0.name") from a value. Empty path returns the value itself. */
export function getPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Text view of an output for string graders: strings as-is, everything else as JSON. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/** Replace "file://relative/path" strings (anywhere in the value) with the file's contents. */
export function resolveFileRefs<T>(value: T, baseDir: string): T {
  if (typeof value === "string" && value.startsWith("file://")) {
    const p = value.slice("file://".length);
    return readFileSync(isAbsolute(p) ? p : resolve(baseDir, p), "utf8") as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveFileRefs(v, baseDir)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFileRefs(v, baseDir)])) as T;
  }
  return value;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a shell command, optionally piping `input` to stdin. Never throws on non-zero exit. */
export function runCommand(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    // detached: the shell and everything it starts form one process group, so a timeout can
    // kill the real program (e.g. `claude`), not just the shell wrapping it.
    const child = spawn(cmd, {
      shell: true,
      detached: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup();
          }, opts.timeoutMs)
        : undefined;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {}); // the target may exit without reading stdin
    child.stdin.end(opts.input ?? "");
  });
}

/** Run async tasks with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function withTimeout<T>(promise: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

export class TimeoutError extends Error {}

/** The environment failed (timeout, unreachable endpoint, HTTP 5xx). Retried, and never scored as FAIL. */
export class InfraError extends Error {}

/** The code under test itself failed (non-zero exit, thrown exception, HTTP 4xx). Scored as FAIL, not retried. */
export class TargetError extends Error {}

export const dirOf = (file: string) => dirname(resolve(file));
