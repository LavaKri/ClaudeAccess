// Thin wrappers around the server's REST endpoints, which just read and write
// what Claude Code already persists on disk (see plan.md) — no storage of
// our own.

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

export async function renameSession (cwd, sessionId, title) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title?cwd=${encodeURIComponent(cwd)}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	return response.ok;
}

export async function deleteSession (cwd, sessionId) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`, {
		method: 'DELETE',
	});
	return response.ok;
}

export async function duplicateSession (cwd, sessionId) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/duplicate?cwd=${encodeURIComponent(cwd)}`, {
		method: 'POST',
	});
	if (!response.ok) return null;
	return response.json();
}
