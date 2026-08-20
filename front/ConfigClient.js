// Thin wrapper around the server's /api/config endpoint, with a simple
// in-memory cache: several parts of the front end (i18n, the options page,
// the prompt form defaults) all need the same config, and it doesn't change
// within a single page load except through updateConfig() itself.

let cached = null;

export async function fetchConfig () {
	if (cached) return cached;
	let response = await fetch('/api/config');
	cached = await response.json();
	return cached;
}

export async function updateConfig (patch) {
	let response = await fetch('/api/config', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(patch),
	});
	cached = await response.json();
	return cached;
}
