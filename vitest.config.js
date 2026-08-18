import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    coverage: {
      include: ["src/**/*.js"],
      reporter: ["text", "html"],
    },
  },
});
