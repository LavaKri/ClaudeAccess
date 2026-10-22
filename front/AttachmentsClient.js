// Thin wrappers around the server's prompt attachment endpoints (see
// server/attachments.js): files are uploaded one by one as soon as they're
// picked, and only referred to by id in the prompt that uses them.

// Resolves with { id, name, size, kind } for an accepted file, or
// { error, maxSizeMB? } — error: 'tooLarge' | 'unsupported' | 'empty' |
// 'invalid' | 'network'.
export async function uploadAttachment (file) {
	let body = new FormData();
	body.append('file', file);
	try {
		let response = await fetch('/api/attachments', { method: 'POST', body });
		return await response.json();
	} catch {
		return { error: 'network' };
	}
}

export async function deleteAttachment (id) {
	try {
		let response = await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
		return response.ok;
	} catch {
		return false;
	}
}
