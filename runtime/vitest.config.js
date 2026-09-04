/**
 * vitest.config.js — test runner configuration for @veg/hyphaeon-runtime.
 *
 * WHY THIS FILE EXISTS. The suite runs under plain Node (no jsdom): the runtime package has no DOM,
 * and the browser session module is exercised with a faked onnxruntime the way DM3's
 * axomeme-session test does. The pipeline test loads a 7.8 MB ONNX graph through onnxruntime-node
 * and scores a real alignment, which takes seconds rather than milliseconds, hence the timeout.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.js'],
		environment: 'node',
		testTimeout: 120_000,
		hookTimeout: 120_000
	}
});
