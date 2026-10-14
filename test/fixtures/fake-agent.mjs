// A fake coding agent: reads the request, edits files in the workspace like a real agent would.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const { input, workspace } = JSON.parse(raw);
  const toolCalls = [{ name: "Read", args: { path: "src/math.mjs" } }];
  if (input === "fix") {
    writeFileSync(join(workspace, "src/math.mjs"), "export const add = (a, b) => a + b;\n");
    toolCalls.push({ name: "Edit", args: { path: "src/math.mjs" } });
  }
  if (input === "cheat") {
    writeFileSync(join(workspace, "RULES.md"), "rewritten\n");
    toolCalls.push({ name: "Write", args: { path: "RULES.md" } });
  }
  if (input === "peek") {
    // The hidden check must not exist while the agent runs.
    let saw = true;
    try { readFileSync(join(workspace, "check.mjs")); } catch { saw = false; }
    process.stdout.write(JSON.stringify({ output: saw ? "saw hidden test" : "no hidden test", toolCalls }));
    return;
  }
  process.stdout.write(JSON.stringify({ output: "done", toolCalls }));
});
