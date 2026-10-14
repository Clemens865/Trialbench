// Example target: reads the case JSON from stdin and prints a result JSON on stdout.
// Replace this with a thin wrapper around your real code (an LLM call, an agent, a CLI).
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const { input } = JSON.parse(raw);
  const text = String(input ?? "").trim();
  const output = text ? text.split(/(?<=\.)\s+/)[0] : "There is nothing to summarize: the input is empty.";
  // Optionally report tool calls and usage so tool graders and cost tracking work:
  // { output, toolCalls: [{ name: "search", args: {...} }], usage: { inputTokens, outputTokens, costUsd } }
  process.stdout.write(JSON.stringify({ output }));
});
