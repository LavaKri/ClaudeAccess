// Sets the app version to today's date (year.month.day, no leading zeros)
// in front/appInfo.js and package.json, then stages both files. Run by the
// .githooks/pre-commit hook, so every commit carries the date it was made
// on; also runnable by hand with `npm run bump-version`.

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appInfoPath = path.join(root, 'front', 'appInfo.js');
const packagePath = path.join(root, 'package.json');

let now = new Date();
let version = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;

let appInfo = await readFile(appInfoPath, 'utf8');
let newAppInfo = appInfo.replace(/(export const APP_VERSION = ')[^']*(';)/, `$1${version}$2`);

let pkg = await readFile(packagePath, 'utf8');
// Targeted replace rather than JSON.parse/stringify, to leave the file's
// formatting untouched.
let newPkg = pkg.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);

let changed = [];
if (newAppInfo !== appInfo) {
	await writeFile(appInfoPath, newAppInfo);
	changed.push(appInfoPath);
}
if (newPkg !== pkg) {
	await writeFile(packagePath, newPkg);
	changed.push(packagePath);
}
if (changed.length && process.argv.includes('--stage')) {
	execFileSync('git', ['add', ...changed], { cwd: root });
}
console.log(`Version ${version}${changed.length ? '' : ' (unchanged)'}`);
