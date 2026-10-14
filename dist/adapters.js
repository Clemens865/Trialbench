import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InfraError, TargetError, TimeoutError, runCommand, withTimeout } from "./util.js";
/**
 * Normalize whatever a target returned. A target may return the full TargetResult
 * ({ output, toolCalls?, usage? }) or just a bare value, which becomes `output`.
 */
export function normalizeResult(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "output" in raw)
        return raw;
    return { output: raw };
}
export function buildRequest(c, trial, workspace, env) {
    return {
        caseId: c.id,
        trial,
        input: c.input,
        ...(c.metadata ? { metadata: c.metadata } : {}),
        ...(workspace ? { workspace } : {}),
        ...(env && Object.keys(env).length ? { env } : {}),
    };
}
/** What a target actually receives: the request without process-level settings. */
function wireRequest(r) {
    const { env: _env, ...rest } = r;
    return rest;
}
export async function callTarget(target, request, baseDir, defaultTimeoutMs) {
    const timeoutMs = target.timeoutMs ?? defaultTimeoutMs;
    switch (target.type) {
        case "exec":
            return callExec(target, request, baseDir, timeoutMs);
        case "http":
            return callHttp(target, request, timeoutMs);
        case "function":
            return callFunction(target, request, baseDir, timeoutMs);
        case "claude-code":
            return callClaudeCode(target, request, baseDir, timeoutMs);
        case "noop":
            return { output: "" };
        case "patch": {
            if (!request.workspace)
                throw new InfraError("patch target needs a workspace");
            const r = await runCommand(`git apply --whitespace=nowarn ${JSON.stringify(resolve(baseDir, target.patch))}`, { cwd: request.workspace, env: request.env ?? {}, timeoutMs });
            if (r.code !== 0)
                throw new TargetError(`reference patch does not apply: ${firstErrorLine(r.stderr)}`);
            return { output: "applied reference patch" };
        }
    }
}
/**
 * exec: the request JSON goes to stdin; the target prints its result JSON on stdout.
 * Plain-text stdout is accepted too and becomes `output` (handy for simple CLIs).
 */
async function callExec(target, request, baseDir, timeoutMs) {
    const res = await runCommand(target.cmd, {
        cwd: target.cwd ? resolve(baseDir, target.cwd) : baseDir,
        env: {
            ...request.env,
            ...target.env,
            TRIALBENCH_CASE_ID: request.caseId,
            TRIALBENCH_TRIAL: String(request.trial),
            ...(request.workspace ? { TRIALBENCH_WORKSPACE: request.workspace } : {}),
        },
        input: JSON.stringify(wireRequest(request)),
        timeoutMs,
    });
    if (res.timedOut)
        throw new InfraError(`exec target timed out after ${timeoutMs}ms`);
    if (res.code !== 0)
        throw new TargetError(`exec target exited with code ${res.code}: ${firstErrorLine(res.stderr)}`);
    const out = res.stdout.trim();
    try {
        return normalizeResult(JSON.parse(out));
    }
    catch {
        return { output: out };
    }
}
/** The most useful line of a stack trace / stderr dump: the first line mentioning an error, else the first line. */
export function firstErrorLine(stderr) {
    const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    const hit = lines.find((l) => /error|exception|traceback|panic/i.test(l) && !/^\s*at\s/.test(l));
    return (hit ?? lines[0] ?? "(no stderr)").slice(0, 300);
}
async function callHttp(target, request, timeoutMs) {
    let response;
    try {
        response = await fetch(target.url, {
            method: target.method ?? "POST",
            headers: { "content-type": "application/json", ...target.headers },
            body: JSON.stringify(wireRequest(request)),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (err) {
        throw new InfraError(`http target unreachable: ${err.message}`);
    }
    const text = await response.text();
    if (response.status >= 500)
        throw new InfraError(`http target returned ${response.status}: ${text.slice(0, 500)}`);
    if (!response.ok)
        throw new TargetError(`http target returned ${response.status}: ${text.slice(0, 500)}`);
    try {
        return normalizeResult(JSON.parse(text));
    }
    catch {
        return { output: text };
    }
}
const moduleCache = new Map();
async function callFunction(target, request, baseDir, timeoutMs) {
    const url = pathToFileURL(resolve(baseDir, target.module)).href;
    if (!moduleCache.has(url))
        moduleCache.set(url, import(url));
    const mod = await moduleCache.get(url);
    const name = target.export ?? "default";
    const fn = mod[name];
    if (typeof fn !== "function")
        throw new InfraError(`${target.module} has no function export "${name}"`);
    try {
        const raw = await withTimeout(Promise.resolve().then(() => fn(wireRequest(request))), timeoutMs, `function target ${name}`);
        return normalizeResult(raw);
    }
    catch (err) {
        if (err instanceof TimeoutError)
            throw new InfraError(err.message);
        throw new TargetError(`function target threw: ${err?.message ?? String(err)}`);
    }
}
/** The prompt for an agent: input.prompt if present, else the input as text; optionally through a template. */
export function agentPrompt(template, input) {
    const text = typeof input === "string"
        ? input
        : input && typeof input === "object" && typeof input.prompt === "string"
            ? input.prompt
            : JSON.stringify(input, null, 2);
    return template ? template.replaceAll("{{input}}", text) : text;
}
const TOOL_RESULT_MAX = 2000;
/** Parse Claude Code's stream-json events into tool calls, the final answer, cost and turns. */
export function parseClaudeStream(ndjson) {
    const toolCalls = [];
    const byId = new Map();
    const assistantText = [];
    let result;
    let isError = false;
    let subtype;
    let costUsd;
    let turns;
    let inputTokens;
    let outputTokens;
    for (const line of ndjson.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{"))
            continue;
        let evt;
        try {
            evt = JSON.parse(t);
        }
        catch {
            continue;
        }
        if (evt.type === "assistant") {
            for (const part of evt.message?.content ?? []) {
                if (part.type === "tool_use") {
                    const call = { name: part.name, args: part.input };
                    toolCalls.push(call);
                    if (part.id)
                        byId.set(part.id, call);
                }
                else if (part.type === "text" && part.text?.trim())
                    assistantText.push(part.text);
            }
        }
        else if (evt.type === "user") {
            for (const part of evt.message?.content ?? []) {
                if (part.type !== "tool_result")
                    continue;
                const call = byId.get(part.tool_use_id);
                if (!call)
                    continue;
                const content = Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("") : String(part.content ?? "");
                call.result = content.length > TOOL_RESULT_MAX ? `${content.slice(0, TOOL_RESULT_MAX)}…` : content;
                if (part.is_error)
                    call.error = true;
            }
        }
        else if (evt.type === "result") {
            result = typeof evt.result === "string" ? evt.result : undefined;
            isError = Boolean(evt.is_error);
            subtype = evt.subtype;
            costUsd = evt.total_cost_usd;
            turns = evt.num_turns;
            const u = evt.usage ?? {};
            inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            outputTokens = u.output_tokens;
        }
    }
    return {
        ...(result !== undefined ? { result } : {}),
        isError,
        ...(subtype ? { subtype } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(turns !== undefined ? { turns } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        toolCalls,
        assistantText,
    };
}
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * claude-code: runs `claude -p` in the trial workspace. Hooks are disabled (a Stop hook can replace
 * the answer under -p) and only project settings load by default, so the repo's CLAUDE.md applies
 * but your personal plugins don't skew the result.
 * An agent that runs out of time or budget FAILED the task; only a CLI that never produced a result is infra.
 */
async function callClaudeCode(target, request, baseDir, timeoutMs) {
    const cwd = request.workspace ?? process.cwd();
    let appended = target.appendSystemPrompt ?? "";
    if (target.appendSystemPromptCmd) {
        // Like every trialbench command, it runs from the config folder; the workspace comes in via env.
        const r = await runCommand(target.appendSystemPromptCmd, { cwd: baseDir, env: { ...request.env, TRIALBENCH_WORKSPACE: cwd }, timeoutMs: 60_000 });
        if (r.code !== 0)
            throw new InfraError(`appendSystemPromptCmd failed: ${firstErrorLine(r.stderr)}`);
        appended = [appended, r.stdout.trim()].filter(Boolean).join("\n\n");
    }
    const args = [
        "-p",
        "--output-format stream-json",
        "--verbose",
        "--no-session-persistence",
        `--settings ${sh(JSON.stringify({ disableAllHooks: true }))}`,
        `--setting-sources ${sh(target.settingSources ?? "project")}`,
        `--permission-mode ${target.permissionMode ?? "acceptEdits"}`,
        target.model ? `--model ${sh(target.model)}` : "",
        target.effort ? `--effort ${target.effort}` : "",
        target.maxBudgetUsd ? `--max-budget-usd ${target.maxBudgetUsd}` : "",
        target.allowedTools?.length ? `--allowedTools ${target.allowedTools.map(sh).join(" ")}` : "",
        target.disallowedTools?.length ? `--disallowedTools ${target.disallowedTools.map(sh).join(" ")}` : "",
        appended ? `--append-system-prompt ${sh(appended)}` : "",
        ...(target.extraArgs ?? []),
    ].filter(Boolean);
    const started = Date.now();
    const res = await runCommand(`claude ${args.join(" ")}`, {
        cwd,
        env: { ...request.env, ...target.env, TRIALBENCH_WORKSPACE: cwd },
        input: agentPrompt(target.prompt, request.input),
        timeoutMs,
    });
    const parsed = parseClaudeStream(res.stdout);
    const usage = {
        ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
        ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
        ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
        ...(parsed.turns !== undefined ? { turns: parsed.turns } : {}),
    };
    const metadata = { durationMs: Date.now() - started, ...(parsed.subtype ? { subtype: parsed.subtype } : {}) };
    if (res.timedOut) {
        throw new TargetError(`agent did not finish within ${timeoutMs}ms after ${parsed.toolCalls.length} tool calls`);
    }
    if (parsed.result === undefined && !parsed.subtype) {
        throw new InfraError(`claude CLI produced no result (exit ${res.code}): ${firstErrorLine(res.stderr || res.stdout)}`);
    }
    return {
        output: parsed.result ?? parsed.assistantText.at(-1) ?? "",
        toolCalls: parsed.toolCalls,
        usage,
        metadata: { ...metadata, ...(parsed.isError ? { agentError: parsed.subtype ?? "error" } : {}) },
    };
}
