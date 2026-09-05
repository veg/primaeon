/**
 * vitest.config.js — the server's test runner settings.
 *
 * WHY THIS FILE EXISTS. The job and OAuth tests drive a real Express app with a real worker pool
 * loading ONNX graphs, so they run serially in one process (one warm session set) and are given
 * a timeout that covers the first session load on a cold machine.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks"
  }
});
