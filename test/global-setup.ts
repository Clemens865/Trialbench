// Run every test inside one throwaway temp root, removed afterwards (os.tmpdir() honours TMPDIR).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "trialbench-tests-"));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
