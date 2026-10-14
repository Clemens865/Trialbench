import type { RunAnalysis } from "./report.js";
import type { RunMeta, Suite, TrialRecord } from "./types.js";
export declare function buildHtml(meta: RunMeta, a: RunAnalysis, records: readonly TrialRecord[], suite?: Suite): string;
