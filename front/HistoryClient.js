// Thin wrappers around the server's read-only REST endpoints, which just
// expose what Claude Code already persists on disk (see plan.md) — no
// storage of our own.

export async function fetchProjects () {
	let response = await fetch('/api/projects');
	return response.json();
}

export async function fetchSessions (cwd) {
	let response = await fetch(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
	return response.json();
}

export async function fetchSession (cwd, sessionId) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`);
	if (!response.ok) return null;
	return response.json();
}
