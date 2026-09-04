// Vitest configuration for @veg/hyphaeon-mcp.
//
// The bridge test runs the Python reference end to end (about 2 s on a laptop, longer on a cold
// torch import), so the per-test timeout is generous. Set HYPHAEON_MCP_SKIP_BRIDGE=1 to skip it.
export default {
  test: {
    environment: "node",
    testTimeout: 180000,
    hookTimeout: 30000,
    include: ["test/**/*.test.js"]
  }
};
