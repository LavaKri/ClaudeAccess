// Resolves the active color theme (config, else the OS/browser's own
// prefers-color-scheme, else light) and applies it as data-theme on <html>,
// same pattern as i18n.js's <html lang>. style.css keys all its color
// tokens off that attribute.

import { fetchConfig } from './ConfigClient.js';

const EXPLICIT_THEMES = ['light', 'dark', 'contrast'];

function prefersDark () {
	return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

// Exported so the options page can live-preview a theme choice before it's
// saved, instead of only taking effect after a reload.
export function applyTheme (configTheme) {
	let resolved = EXPLICIT_THEMES.includes(configTheme) ? configTheme : (prefersDark() ? 'dark' : 'light');
	document.documentElement.dataset.theme = resolved;
}

export async function initTheme () {
	let config = await fetchConfig();
	applyTheme(config.theme);

	// Auto-detect ('' in config): follow the OS theme live if the user
	// switches it while this page stays open, without needing a reload.
	if (!config.theme) {
		window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(''));
	}
}
