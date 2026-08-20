// Single source of truth for the model / effort / permission-mode choices
// `claude` currently exposes (confirmed via `claude -p --help` and
// https://code.claude.com/docs/en/model-config and .../permission-modes on
// 2026-08-20) — both the prompt form and the options page's "defaults for
// new sessions" selects are built from these, so a future Anthropic lineup
// change only needs updating here.
//
// Ordered simplest/fastest to most complex/slowest for MODELS and EFFORTS;
// PERMISSION_MODES follows the official docs' own table order (roughly
// least to most autonomous, with dontAsk's different axis — pre-approved
// tools only — placed where the docs place it).
import { t } from './i18n.js';

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

// Fills a <select> with one <option> per value, translated via
// "<translationPrefix>.<value>", and marks selectedValue as selected.
export function populateSelect (select, values, translationPrefix, selectedValue) {
	select.textContent = '';
	for (let value of values) {
		let option = document.createElement('option');
		option.value = value;
		option.textContent = t(`${translationPrefix}.${value}`);
		option.selected = value === selectedValue;
		select.appendChild(option);
	}
}
