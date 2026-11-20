import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    globals: false,
    // Two workers keeps the suite inside the memory budget of CI/dev boxes
    // (the default worker-per-core fan-out exhausts Windows containers).
    maxWorkers: 2,
  },
});
