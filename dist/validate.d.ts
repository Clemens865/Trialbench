import type { Config, Suite } from "./types.js";
export interface CaseValidation {
    caseId: string;
    oracle?: "PASS" | "FAIL" | "ERROR" | "UNKNOWN" | "no-reference";
    null: "PASS" | "FAIL" | "ERROR" | "UNKNOWN";
    status: "ok" | "broken" | "trivial" | "unverified";
    detail?: string;
}
export declare function validateSuite(suite: Suite, config: Config, opts?: {
    caseIds?: string[];
    concurrency?: number;
}): Promise<CaseValidation[]>;
