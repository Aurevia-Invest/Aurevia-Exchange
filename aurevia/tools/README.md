# Local browser tools

Playwright-managed Chromium is downloaded to `tools/playwright/browsers/` by `npm run browsers:install`. This cache is machine-specific, ignored by Git, and is not included in production builds. Use `npm run tools:install` to reproduce the project dependency and browser setup, and `npm run tools:verify` to confirm the executable launches.

Playwright's Linux shared-library dependencies are installed on the host/container when `npm run tools:install -- --with-deps` is used; they are not stored in this directory.
