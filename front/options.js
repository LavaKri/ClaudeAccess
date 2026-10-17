import { initI18n, t } from './i18n.js';
import { initTheme, applyTheme } from './theme.js';
import { fetchConfig, updateConfig } from './ConfigClient.js';
import { MODELS, EFFORTS, PERMISSION_MODES, populateSelect } from './runOptions.js';

const LANGUAGES = ['fr', 'en'];
const THEMES = ['light', 'dark', 'contrast'];

// language/theme both support an empty value ('' = auto-detect), stored as
// such in config — same convention, so they share this helper. MODELS/
// EFFORTS/PERMISSION_MODES never have an empty option, hence runOptions.js's
// separate populateSelect() not being reused here as-is.
function populateAutoDetectSelect (select, values, translationPrefix, selectedValue) {
	select.textContent = '';
	let autoOption = document.createElement('option');
	autoOption.value = '';
	autoOption.textContent = t(`${translationPrefix}.auto`);
	autoOption.selected = !selectedValue;
	select.appendChild(autoOption);

	for (let value of values) {
		let option = document.createElement('option');
		option.value = value;
		option.textContent = t(`${translationPrefix}.${value}`);
		option.selected = value === selectedValue;
		select.appendChild(option);
	}
}

function setStatus (text) {
	document.getElementById('optionsStatusArea').textContent = text;
}

async function populateForm () {
	let config = await fetchConfig();

	populateAutoDetectSelect(document.getElementById('languageSelect'), LANGUAGES, 'language', config.language);
	populateAutoDetectSelect(document.getElementById('themeSelect'), THEMES, 'theme', config.theme);
	document.getElementById('messagesPerPageInput').value = config.messagesPerPage;
	document.getElementById('sessionsPerPageInput').value = config.sessionsPerPage;
	document.getElementById('titlePreviewWordCountInput').value = config.titlePreviewWordCount;
	document.getElementById('completionSoundInput').checked = config.completionSound;
	document.getElementById('progressAnnounceInput').checked = config.progressAnnounce;
	document.getElementById('showHiddenMessagesInput').checked = config.showHiddenMessages;

	populateSelect(document.getElementById('defaultModelSelect'), MODELS, 'option.model', config.defaultModel);
	populateSelect(document.getElementById('defaultEffortSelect'), EFFORTS, 'option.effort', config.defaultEffort);
	populateSelect(document.getElementById('defaultPermissionModeSelect'), PERMISSION_MODES, 'option.permissionMode', config.defaultPermissionMode);

	document.getElementById('hostInput').value = config.host;
	document.getElementById('portInput').value = config.port;
	document.getElementById('cliCommandInput').value = config.cliCommand;
	document.getElementById('claudeHomeDirInput').value = config.claudeHomeDir;

	applyTheme(config.theme);
}

// Live preview: the chosen theme applies immediately, before Enregistrer is
// even clicked, so the user can see the result right away.
function onThemeChange (event) {
	applyTheme(event.target.value);
}

async function onOptionsSubmit (event) {
	event.preventDefault();

	let patch = {
		language: document.getElementById('languageSelect').value,
		theme: document.getElementById('themeSelect').value,
		messagesPerPage: Number(document.getElementById('messagesPerPageInput').value),
		sessionsPerPage: Number(document.getElementById('sessionsPerPageInput').value),
		titlePreviewWordCount: Number(document.getElementById('titlePreviewWordCountInput').value),
		completionSound: document.getElementById('completionSoundInput').checked,
		progressAnnounce: document.getElementById('progressAnnounceInput').checked,
		showHiddenMessages: document.getElementById('showHiddenMessagesInput').checked,
		defaultModel: document.getElementById('defaultModelSelect').value,
		defaultEffort: document.getElementById('defaultEffortSelect').value,
		defaultPermissionMode: document.getElementById('defaultPermissionModeSelect').value,
		host: document.getElementById('hostInput').value,
		port: Number(document.getElementById('portInput').value),
		cliCommand: document.getElementById('cliCommandInput').value,
		claudeHomeDir: document.getElementById('claudeHomeDirInput').value,
	};

	try {
		await updateConfig(patch);
		setStatus(t('status.optionsSaved'));
	} catch {
		setStatus(t('status.optionsSaveFailed'));
	}
}

// Discards unsaved edits by re-filling the form from the last config actually
// persisted on the server (ConfigClient's cache already reflects that, no
// fresh network round-trip needed) — a plain native type="reset" button
// wouldn't do this correctly, since these fields are populated from fetched
// config rather than HTML default attributes.
async function onResetClick () {
	await populateForm();
	setStatus(t('status.optionsReset'));
}

function onBackClick () {
	window.location.href = 'index.html';
}

async function onWindowLoad () {
	await initTheme();
	await initI18n();
	await populateForm();
	document.getElementById('optionsForm').addEventListener('submit', onOptionsSubmit);
	document.getElementById('resetOptionsButton').addEventListener('click', onResetClick);
	document.getElementById('backButton').addEventListener('click', onBackClick);
	document.getElementById('themeSelect').addEventListener('change', onThemeChange);
}

window.addEventListener('load', onWindowLoad);
