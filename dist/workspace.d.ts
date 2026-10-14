import type { WorkspaceSpec, WorkspaceState } from "./types.js";
/** Workspace env with `~` expanded. */
export declare function workspaceEnv(spec: WorkspaceSpec | undefined): Record<string, string>;
export interface PreparedWorkspace {
    dir: string;
    git: boolean;
    /** sha256 of each protected file before the agent ran. */
    protectedBefore: Map<string, string | null>;
}
/** Paths relative to `root`, recursively, skipping heavy build/dependency folders. */
export declare function listFiles(root: string, dir?: string, out?: string[]): string[];
/** Minimal glob: `*` matches within a path segment, `**` across segments, `?` one char. */
export declare function globToRegExp(glob: string): RegExp;
export declare const matchesAny: (path: string, globs: readonly string[]) => boolean;
export declare function prepareWorkspace(spec: WorkspaceSpec, root: string, caseId: string): Promise<PreparedWorkspace>;
/**
 * After the agent: record its changes, check protected files, then copy hidden files in.
 * Order matters: changes are captured BEFORE hidden tests arrive, so the diff is the agent's work only.
 */
export declare function finishWorkspace(ws: PreparedWorkspace, spec: WorkspaceSpec, root: string): Promise<WorkspaceState>;
export declare function cleanupWorkspace(dir: string): void;
