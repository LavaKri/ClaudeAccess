// Single source of truth for the app's own display name — change here only,
// everywhere else (document.title, the i18n "{{app}}" placeholder) reads it
// from here instead of hardcoding it again.
export const APP_NAME = 'ClaudeAccess';

// Date-based version, year.month.day without leading zeros (also valid
// semver, so package.json carries the same value). Don't edit by hand:
// scripts/bump-version.js rewrites this line (and package.json) on every
// commit, through the .githooks/pre-commit hook.
export const APP_VERSION = '2026.10.22';
