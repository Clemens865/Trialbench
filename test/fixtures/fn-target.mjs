// Deterministic fake app for tests. Behaviour is driven by the case input.
let flaky = 0;
export default async function target({ input }) {
  if (input === "crash") throw new Error("boom");
  if (input === "slow") await new Promise((r) => setTimeout(r, 5000));
  if (input === "flaky") {
    flaky++;
    if (flaky % 2 === 1) await new Promise((r) => setTimeout(r, 5000)); // first attempt times out, retry succeeds
  }
  if (input === "tools") return { output: "done", toolCalls: [{ name: "search" }, { name: "search" }, { name: "write" }] };
  if (input === "json") return { output: '{"name":"Ada","age":36}' };
  return { output: String(input).toUpperCase(), usage: { costUsd: 0.001 } };
}
