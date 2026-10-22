// Builds dist/ClaudeAccess-<version>-win-<arch>.zip: a portable, unzip-and-run
// copy of the app for people who don't have Node.js installed. It bundles the
// node.exe running this script (so the zip targets this machine's own
// Windows architecture), the app's production dependencies, and a
// ClaudeAccess.bat launcher. Run with `npm run build:portable`.

import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { APP_VERSION } from '../front/appInfo.js';

if (process.platform !== 'win32') {
	console.error('The portable build is Windows-only for now.');
	process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const packageName = `ClaudeAccess-${APP_VERSION}-win-${process.arch}`;
const stagingDir = path.join(distDir, packageName);
const zipPath = path.join(distDir, `${packageName}.zip`);

// What the app needs at runtime; everything else (mock/, plan.md, .claude/,
// dev dependencies) stays out of the zip.
const APP_FILES = ['server', 'front', 'package.json', 'package-lock.json', 'LICENSE', 'README.md'];

// cd to its own folder first: the server serves front/ relative to the
// current directory. Closing the console window stops the server; the pause
// keeps the window open on a startup error so the message can be read.
const LAUNCHER = [
	'@echo off',
	'cd /d "%~dp0"',
	'node\\node.exe server\\server.js --open',
	'if errorlevel 1 pause',
	'',
].join('\r\n');

async function exists (file) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

await rm(stagingDir, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(stagingDir, { recursive: true });

console.log(`Copying app files to ${stagingDir}`);
for (let file of APP_FILES) {
	await cp(path.join(root, file), path.join(stagingDir, file), { recursive: true });
}

console.log('Installing production dependencies');
// Through a shell: npm is npm.cmd on Windows, which can't be spawned directly.
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: stagingDir, stdio: 'inherit' });

console.log(`Bundling ${process.execPath} (Node.js ${process.version})`);
let nodeDir = path.join(stagingDir, 'node');
await mkdir(nodeDir);
await cp(process.execPath, path.join(nodeDir, 'node.exe'));
// Node.js's own license, from its installation folder, next to its binary.
let nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
if (await exists(nodeLicense)) await cp(nodeLicense, path.join(nodeDir, 'LICENSE'));

await writeFile(path.join(stagingDir, 'ClaudeAccess.bat'), LAUNCHER);

console.log(`Creating ${zipPath}`);
// Windows' own bsdtar (not a Git Bash/MSYS tar that may come first in PATH):
// -a picks the zip format from the archive's extension.
let tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', distDir, packageName], { stdio: 'inherit' });

await rm(stagingDir, { recursive: true, force: true });
console.log('Done.');
