// Per-trial workspaces for agents and coding agents.
//
// Every trial gets a FRESH directory (never reused: state leaking between trials is the most
// common way agent evals lie). It can start empty, as a copy of a template folder, or as a
// clone of a git repo at a fixed commit. After the agent stops, hidden files (tests the agent
// must not see) are copied in, protected files are checked for tampering, and the changes the
// agent made are recorded so graders and humans can inspect them.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { InfraError, runCommand, sha256 } from "./util.js";
/** Workspace env with `~` expanded. */
export function workspaceEnv(spec) {
    return Object.fromEntries(Object.entries(spec?.env ?? {}).map(([k, v]) => [k, v.replace(/^~(?=\/|$)/, homedir())]));
}
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", ".next", ".venv", "__pycache__", ".trialbench-cache"]);
/** Paths relative to `root`, recursively, skipping heavy build/dependency folders. */
export function listFiles(root, dir = root, out = []) {
    if (!existsSync(dir))
        return out;
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        let st;
        try {
            st = statSync(p);
        }
        catch {
            continue;
        }
        if (st.isDirectory()) {
            if (!SKIP_DIRS.has(name))
                listFiles(root, p, out);
        }
        else
            out.push(relative(root, p).split(sep).join("/"));
    }
    return out;
}
/** Minimal glob: `*` matches within a path segment, `**` across segments, `?` one char. */
export function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                re += ".*";
                i++;
                if (glob[i + 1] === "/")
                    i++;
            }
            else
                re += "[^/]*";
        }
        else if (c === "?")
            re += "[^/]";
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}
export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));
function hashFile(p) {
    return existsSync(p) ? sha256(readFileSync(p).toString("base64")) : null;
}
function hashProtected(dir, globs) {
    const m = new Map();
    for (const f of listFiles(dir))
        if (matchesAny(f, globs))
            m.set(f, hashFile(join(dir, f)));
    return m;
}
export async function prepareWorkspace(spec, root, caseId) {
    const base = resolve(root, spec.parentDir ?? tmpdir());
    mkdirSync(base, { recursive: true });
    const dir = realpathSync(mkdtempSync(join(base, `trialbench-${caseId.replace(/[^\w.-]+/g, "_").slice(0, 40)}-`)));
    let git = false;
    if (spec.git) {
        const repo = resolve(root, spec.git.repo);
        // --shared reuses the source repo's objects: fast, and no network.
        const clone = await runCommand(`git clone --quiet --shared --no-checkout ${q(repo)} ${q(dir)}`, { timeoutMs: 300_000 });
        if (clone.code !== 0)
            throw new InfraError(`git clone failed: ${clone.stderr.trim()}`);
        const ref = spec.git.ref ?? "HEAD";
        const co = await runCommand(`git checkout --quiet --detach ${q(ref)}`, { cwd: dir, timeoutMs: 300_000 });
        if (co.code !== 0)
            throw new InfraError(`git checkout ${ref} failed: ${co.stderr.trim()}`);
        if (spec.git.stripFutureHistory !== false) {
            // The agent must not be able to read the answer from later commits.
            await runCommand("git remote remove origin; git for-each-ref --format='%(refname)' refs/ | xargs -n1 git update-ref -d 2>/dev/null; git reflog expire --expire=now --all; git gc --quiet --prune=now", { cwd: dir, timeoutMs: 300_000 });
            await runCommand("git checkout --quiet -b trialbench-task", { cwd: dir, timeoutMs: 30_000 });
        }
        git = true;
    }
    else if (spec.template) {
        cpSync(resolve(root, spec.template), dir, { recursive: true });
    }
    for (const rel of spec.remove ?? [])
        rmSync(join(dir, rel), { recursive: true, force: true });
    if (!git) {
        // A git baseline makes "what did the agent change?" a plain `git diff`.
        await runCommand("git init --quiet && git add -A && git -c user.email=t@b -c user.name=trialbench commit --quiet --allow-empty -m baseline", { cwd: dir, timeoutMs: 60_000 });
        git = true;
    }
    if (spec.setup) {
        const r = await runCommand(spec.setup, { cwd: dir, timeoutMs: spec.setupTimeoutMs ?? 600_000, env: { ...workspaceEnv(spec), TRIALBENCH_WORKSPACE: dir } });
        if (r.code !== 0)
            throw new InfraError(`workspace setup failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
        // Setup output (installed deps, generated files) is part of the starting point, not the agent's work.
        await runCommand("git add -A && git -c user.email=t@b -c user.name=trialbench commit --quiet --allow-empty -m setup", { cwd: dir, timeoutMs: 60_000 });
    }
    return { dir, git, protectedBefore: hashProtected(dir, spec.protect ?? []) };
}
/**
 * After the agent: record its changes, check protected files, then copy hidden files in.
 * Order matters: changes are captured BEFORE hidden tests arrive, so the diff is the agent's work only.
 */
export async function finishWorkspace(ws, spec, root) {
    await runCommand("git add -A", { cwd: ws.dir, timeoutMs: 60_000 });
    const names = await runCommand("git diff --cached --name-status HEAD", { cwd: ws.dir, timeoutMs: 60_000 });
    const changed = names.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status: status ?? "?", path: rest[rest.length - 1] ?? "" };
    });
    const diff = await runCommand("git diff --cached --stat HEAD && git diff --cached HEAD", { cwd: ws.dir, timeoutMs: 60_000 });
    const maxDiff = 50_000;
    const tampered = [];
    for (const [f, before] of ws.protectedBefore)
        if (hashFile(join(ws.dir, f)) !== before)
            tampered.push(f);
    if (spec.protectNew)
        for (const f of listFiles(ws.dir))
            if (matchesAny(f, spec.protect ?? []) && !ws.protectedBefore.has(f))
                tampered.push(f);
    for (const h of spec.hidden ?? []) {
        const src = resolve(root, h.from);
        if (!existsSync(src))
            throw new InfraError(`hidden files not found: ${src}`);
        cpSync(src, join(ws.dir, h.to ?? "."), { recursive: true, force: true });
    }
    return {
        dir: ws.dir,
        changed,
        diff: diff.stdout.length > maxDiff ? `${diff.stdout.slice(0, maxDiff)}\n… (diff truncated at ${maxDiff} chars)` : diff.stdout,
        tampered,
    };
}
export function cleanupWorkspace(dir) {
    rmSync(dir, { recursive: true, force: true });
}
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
