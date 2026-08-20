// Minimal i18n runtime: resolves the active language (config, else browser,
// else "en"), loads its flat JSON dictionary, applies it to the static HTML
// via data-i18n/data-i18n-attr, and exposes t() for dynamic strings built in
// JS. No framework, no build step — consistent with the rest of front/.

import { fetchConfig } from './ConfigClient.js';
import { APP_NAME } from './appInfo.js';

const SUPPORTED_LANGUAGES = ['fr', 'en'];
const FALLBACK_LANGUAGE = 'en';

let translations = {};
let currentLanguage = FALLBACK_LANGUAGE;

// navigator.languages is already ordered by the user's own preference; the
// first entry that matches a language this app actually ships wins.
function detectBrowserLanguage () {
	for (let lang of navigator.languages || [navigator.language]) {
		let short = lang.slice(0, 2).toLowerCase();
		if (SUPPORTED_LANGUAGES.includes(short)) return short;
	}
	return FALLBACK_LANGUAGE;
}

async function resolveLanguage () {
	try {
		let config = await fetchConfig();
		if (config.language && SUPPORTED_LANGUAGES.includes(config.language)) return config.language;
	} catch {
		// Config unreachable: fall through to browser detection below.
	}
	return detectBrowserLanguage();
}

// Replaces {{name}} placeholders in a translated string with the given
// values — used for the many dynamic strings (statuses, dialogs, tool
// descriptions) that carry runtime data.
export function t (key, vars) {
	let text = translations[key] ?? key;
	// { app: APP_NAME } is always available as a placeholder, so translated
	// strings can reference the app's own name ("{{app}}") without every
	// caller having to pass it in.
	for (let [name, value] of Object.entries({ app: APP_NAME, ...vars })) {
		text = text.replaceAll(`{{${name}}}`, value);
	}
	return text;
}

// data-i18n="key" replaces the element's text content.
// data-i18n-attr="attr1:key1;attr2:key2" sets translated attributes instead
// (e.g. aria-label, placeholder) — an element can carry both.
function applyStaticTranslations () {
	for (let el of document.querySelectorAll('[data-i18n]')) {
		el.textContent = t(el.dataset.i18n);
	}
	for (let el of document.querySelectorAll('[data-i18n-attr]')) {
		for (let pair of el.dataset.i18nAttr.split(';')) {
			let [attr, key] = pair.split(':').map(part => part.trim());
			if (attr && key) el.setAttribute(attr, t(key));
		}
	}
}

// Resolves the language, loads its dictionary, sets <html lang> (left
// unset in the static HTML until this runs, per plan.md), and translates
// whatever's already in the DOM. Returns the resolved language code.
export async function initI18n () {
	currentLanguage = await resolveLanguage();

	let response = await fetch(`/lang/${currentLanguage}.json`);
	translations = await response.json();

	document.documentElement.lang = currentLanguage;
	applyStaticTranslations();
	return currentLanguage;
}

export function getLanguage () {
	return currentLanguage;
}
