// Vitest configuration for @veg/hyphaeon-mcp.
//
// The parity tests load an ONNX graph and score whole alignments (the bat_oas1 report and the
// RHO phenotype run are tens of seconds on a laptop CPU), so the per-test timeout is generous.
// Nothing here starts a subprocess: every pillar runs in-process since Phase 3.
export default {
  test: {
    environment: "node",
    testTimeout: 180000,
    hookTimeout: 30000,
    include: ["test/**/*.test.js"]
  }
};
