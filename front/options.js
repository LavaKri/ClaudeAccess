import { initI18n, t } from './i18n.js';
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
	document.getElementById('completionSoundInput').checked = config.completionSound;

	populateSelect(document.getElementById('defaultModelSelect'), MODELS, 'option.model', config.defaultModel);
	populateSelect(document.getElementById('defaultEffortSelect'), EFFORTS, 'option.effort', config.defaultEffort);
	populateSelect(document.getElementById('defaultPermissionModeSelect'), PERMISSION_MODES, 'option.permissionMode', config.defaultPermissionMode);

	document.getElementById('cliCommandInput').value = config.cliCommand;
	document.getElementById('claudeHomeDirInput').value = config.claudeHomeDir;
}

async function onOptionsSubmit (event) {
	event.preventDefault();

	let patch = {
		language: document.getElementById('languageSelect').value,
		theme: document.getElementById('themeSelect').value,
		messagesPerPage: Number(document.getElementById('messagesPerPageInput').value),
		sessionsPerPage: Number(document.getElementById('sessionsPerPageInput').value),
		completionSound: document.getElementById('completionSoundInput').checked,
		defaultModel: document.getElementById('defaultModelSelect').value,
		defaultEffort: document.getElementById('defaultEffortSelect').value,
		defaultPermissionMode: document.getElementById('defaultPermissionModeSelect').value,
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

async function onWindowLoad () {
	await initI18n();
	await populateForm();
	document.getElementById('optionsForm').addEventListener('submit', onOptionsSubmit);
}

window.addEventListener('load', onWindowLoad);
