import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration tests spawn git and node; give them room on a busy machine.
  test: { globalSetup: ["test/global-setup.ts"], testTimeout: 30_000 },
});
