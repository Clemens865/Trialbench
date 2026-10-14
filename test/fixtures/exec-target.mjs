let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const { input } = JSON.parse(raw);
  if (input === "exit1") { console.error("Error: invalid input"); process.exit(1); }
  if (input === "plain") { process.stdout.write("plain text answer"); return; }
  process.stdout.write(JSON.stringify({ output: `echo:${input}` }));
});
