# hyphaeon-app

Everything that *runs* HyphAeon: the SvelteKit web app (`web/`), the ONNX runtime glue and
pipeline orchestration (`runtime/`), the Node MCP server (`mcp/`), and, in a later phase, the Node
job server (`server/`). All of it consumes `@veg/hyphaeon-js`, the library of pure functions in
`../HyphAeon/js` that mirrors the Python reference in `../HyphAeon/hyphaeon/`.

The plan of record is `PLAN.md`. The project notebook (commands, why-config, release notes) is
`CLAUDE.md`.

```
npm install          # root, installs every workspace (runtime links ../HyphAeon/js by file:)
npm test             # vitest in every workspace that has a test script
npm run build        # web/ static build
```

HyphAeon is a neural surrogate for HyPhy MEME: every result carries `is_surrogate` and a path to
run the real analysis on Datamonkey. Sequences never leave the browser on the default path.
