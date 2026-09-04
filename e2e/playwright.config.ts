/**
 * playwright.config.ts — Playwright configuration for the HyphAeon web app's delivery tests.
 *
 * WHY THIS FILE EXISTS. PLAN.md Appendix A: "e2e/ — Playwright: delivery assertions (origins,
 * headers, bytes per route)." The pattern is datamonkey3/playwright.config.js, reduced to what
 * this suite needs:
 *
 *   - Chromium only. The assertions are about which URLs the page requests and which headers the
 *     server sends; they do not vary by browser engine, and one project keeps the suite fast.
 *   - The BUILT site, served by `vite preview`, never `vite dev`. The dev server transforms modules
 *     on demand and injects its own client, so a dev-server run would not see the asset graph a
 *     user sees. The build itself is a separate step (`npm run build` in web/) so that a failing
 *     build reads as a build failure, not as a test timeout.
 *   - reuseExistingServer: false. A stale preview on 4173 from an older build would make every
 *     assertion here pass or fail for someone else's reason; --strictPort makes a busy port an
 *     error rather than a silent move to 4174, which the baseURL would not follow.
 */

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = 4173;
const webDir = fileURLToPath(new URL('../web', import.meta.url));

export default defineConfig({
	testDir: '.',
	testMatch: /.*\.spec\.ts$/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'github' : 'list',
	timeout: 60_000,
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	],
	webServer: {
		command: `npm run preview -- --port ${PORT} --strictPort`,
		cwd: webDir,
		url: `http://localhost:${PORT}/`,
		reuseExistingServer: false,
		timeout: 60_000
	}
});
