import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Case, TargetResult, TargetSpec } from "./types.js";
import { InfraError, TargetError, TimeoutError, runCommand, withTimeout } from "./util.js";

/** The JSON document every target receives. */
export interface TargetRequest {
  caseId: string;
  trial: number;
  input: unknown;
  metadata?: Record<string, unknown>;
}

export type TargetFn = (request: TargetRequest) => Promise<TargetResult | unknown> | TargetResult | unknown;

/**
 * Normalize whatever a target returned. A target may return the full TargetResult
 * ({ output, toolCalls?, usage? }) or just a bare value, which becomes `output`.
 */
export function normalizeResult(raw: unknown): TargetResult {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "output" in raw) return raw as TargetResult;
  return { output: raw };
}

export function buildRequest(c: Case, trial: number): TargetRequest {
  return { caseId: c.id, trial, input: c.input, ...(c.metadata ? { metadata: c.metadata } : {}) };
}

export async function callTarget(target: TargetSpec, request: TargetRequest, baseDir: string, defaultTimeoutMs: number): Promise<TargetResult> {
  const timeoutMs = target.timeoutMs ?? defaultTimeoutMs;
  switch (target.type) {
    case "exec":
      return callExec(target, request, baseDir, timeoutMs);
    case "http":
      return callHttp(target, request, timeoutMs);
    case "function":
      return callFunction(target, request, baseDir, timeoutMs);
  }
}

/**
 * exec: the request JSON goes to stdin; the target prints its result JSON on stdout.
 * Plain-text stdout is accepted too and becomes `output` (handy for simple CLIs).
 */
async function callExec(target: Extract<TargetSpec, { type: "exec" }>, request: TargetRequest, baseDir: string, timeoutMs: number): Promise<TargetResult> {
  const res = await runCommand(target.cmd, {
    cwd: target.cwd ? resolve(baseDir, target.cwd) : baseDir,
    env: { ...target.env, TRIALBENCH_CASE_ID: request.caseId, TRIALBENCH_TRIAL: String(request.trial) },
    input: JSON.stringify(request),
    timeoutMs,
  });
  if (res.timedOut) throw new InfraError(`exec target timed out after ${timeoutMs}ms`);
  if (res.code !== 0) throw new TargetError(`exec target exited with code ${res.code}: ${firstErrorLine(res.stderr)}`);
  const out = res.stdout.trim();
  try {
    return normalizeResult(JSON.parse(out));
  } catch {
    return { output: out };
  }
}

/** The most useful line of a stack trace / stderr dump: the first line mentioning an error, else the first line. */
export function firstErrorLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|exception|traceback|panic/i.test(l) && !/^\s*at\s/.test(l));
  return (hit ?? lines[0] ?? "(no stderr)").slice(0, 300);
}

async function callHttp(target: Extract<TargetSpec, { type: "http" }>, request: TargetRequest, timeoutMs: number): Promise<TargetResult> {
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: target.method ?? "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new InfraError(`http target unreachable: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (response.status >= 500) throw new InfraError(`http target returned ${response.status}: ${text.slice(0, 500)}`);
  if (!response.ok) throw new TargetError(`http target returned ${response.status}: ${text.slice(0, 500)}`);
  try {
    return normalizeResult(JSON.parse(text));
  } catch {
    return { output: text };
  }
}

const moduleCache = new Map<string, Promise<Record<string, unknown>>>();

async function callFunction(target: Extract<TargetSpec, { type: "function" }>, request: TargetRequest, baseDir: string, timeoutMs: number): Promise<TargetResult> {
  const url = pathToFileURL(resolve(baseDir, target.module)).href;
  if (!moduleCache.has(url)) moduleCache.set(url, import(url) as Promise<Record<string, unknown>>);
  const mod = await moduleCache.get(url)!;
  const name = target.export ?? "default";
  const fn = mod[name];
  if (typeof fn !== "function") throw new InfraError(`${target.module} has no function export "${name}"`);
  try {
    const raw = await withTimeout(Promise.resolve().then(() => (fn as TargetFn)(request)), timeoutMs, `function target ${name}`);
    return normalizeResult(raw);
  } catch (err) {
    if (err instanceof TimeoutError) throw new InfraError(err.message);
    throw new TargetError(`function target threw: ${(err as Error)?.message ?? String(err)}`);
  }
}
