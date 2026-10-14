export interface TaskFromCommitOptions {
    repo: string;
    commit: string;
    /** Where evals live (the folder with trialbench.config.yaml). */
    root: string;
    id?: string;
    /** Which of the commit's files are the hidden tests. Default: files that look like tests. */
    tests?: string[];
    /** Command that runs the hidden tests in the workspace. Default: guessed for cargo / npm projects. */
    testCmd?: string;
}
export interface TaskFromCommitResult {
    id: string;
    dir: string;
    testFiles: string[];
    testCmd: string;
    caseYaml: string;
    instruction: string;
}
/** Best-effort default test command from the test files' locations. */
export declare function guessTestCmd(testFiles: string[], repo: string): string | undefined;
export declare function taskFromCommit(opts: TaskFromCommitOptions): Promise<TaskFromCommitResult>;
