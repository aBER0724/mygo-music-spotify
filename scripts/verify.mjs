// Checks what tests don't: that the manifest, package and translations agree
// with the code. Run with `npm run verify`.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("plugin.json"));
const pkg = JSON.parse(read("package.json"));
const zh = JSON.parse(read("locales/zh-CN.json"));
const source = read(manifest.main);
const problems = [];

if (manifest.version !== pkg.version) problems.push(`plugin.json is ${manifest.version} but package.json is ${pkg.version}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push(`version ${manifest.version} isn't x.y.z`);
// When there is a changelog, it has to cover this version. It is empty for
// now: the 1.0.0 release notes come from the commit history instead.
const changelog = read("CHANGELOG.md").trim();
if (changelog && !changelog.includes(`## [${manifest.version}]`)) {
  problems.push(`CHANGELOG.md has no entry for ${manifest.version}`);
}
if (pkg.license !== "AGPL-3.0-only" || !source.startsWith("// SPDX-License-Identifier: AGPL-3.0-only")) problems.push("license isn't stated as AGPL-3.0-only in package.json and the source");
// The folder Soloist is unpacked into has to exist in an installed plugin:
// the download goes to the plugin's data folder, so nothing else makes it.
try { read("soloist/README.txt"); } catch { problems.push("soloist/README.txt is missing, so Soloist can't be unpacked after an update"); }

// What this checks by reading the code has to be in the code: a template
// string, or a URL put together at run time, would get past every check below.
if (/\bt\(`/.test(source)) problems.push("a t() template string, which verify can't read");
if (/\b(?:run|spawnProgram)\(`/.test(source)) problems.push("a program started with a template string, which verify can't read");
if (/`https:\/\/[^`/]*\$\{/.test(source) || /"https:\/\/"\s*\+/.test(source)) problems.push("a host built at run time, which verify can't check");

// Every text the listener sees has a Simplified Chinese translation.
const texts = new Set();
for (const match of source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"\)/g)) texts.add(JSON.parse(`"${match[1]}"`));
for (const setting of manifest.settings || []) {
  texts.add(setting.label);
  if (setting.help) texts.add(setting.help);
}
for (const item of manifest.navigation || []) if (item.title) texts.add(item.title);
for (const text of texts) if (!(text in zh)) problems.push(`no zh-CN translation for: ${text}`);
for (const key of Object.keys(zh)) if (!texts.has(key) && key !== manifest.name) problems.push(`unused zh-CN translation: ${key}`);
for (const [key, value] of Object.entries(zh)) {
  for (const placeholder of key.match(/\{\w+\}/g) || []) {
    if (!value.includes(placeholder)) problems.push(`zh-CN translation drops ${placeholder}: ${key}`);
  }
}

// What the host needs is exported.
const exported = new Set([...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]));
const needed = manifest.playback === "remote"
  ? ["signIn", "signOut", "account", "remotePlay", "remotePause", "remoteResume", "remoteSeek", "remoteVolume", "remoteState", "remoteDevices", "remoteUse"]
  : ["stream"];
for (const name of needed) if (!exported.has(name)) problems.push(`doesn't export ${name}`);

// Hosts the code reaches are in the network permission, and no more.
const network = new Set(manifest.permissions?.network || []);
const reached = new Set([...source.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => [m[1]]).flat(Infinity));
reached.delete("open.spotify.com"); // links for sharing, never fetched
reached.delete("soloist-builds.spotifycdn.com"); // fetched by curl, not by the plugin
for (const host of reached) if (!network.has(host)) problems.push(`fetches ${host} without the network permission`);
for (const host of network) if (!reached.has(host)) problems.push(`network permission for ${host}, which the code doesn't reach`);

// Programs the code starts are in the process permission, and nothing else is.
// Each call has to name its program as a literal (or as soloistBinary()), so
// that a program started some other way can't get past this check.
const programs = new Set(manifest.permissions?.process || []);
const started = new Set();
for (const call of source.matchAll(/\b(?:run|spawnProgram|host\.spawn)\(/g)) {
  const after = source.slice(call.index + call[0].length, call.index + call[0].length + 48);
  const literal = /^\s*"([^"$]+)"/.exec(after);
  if (literal) {
    started.add(literal[1]);
    continue;
  }
  if (/^\s*soloistBinary\(\)/.test(after)) {
    // One file, named for the platform by the code.
    started.add("soloist/soloist");
    started.add("soloist/soloist.exe");
    continue;
  }
  // The wrappers are called with the name their caller has already checked.
  if (/^\s*command, args\)/.test(after)) continue;
  problems.push(`starts a program without a literal name: ${call[0]}...`);
}
for (const program of started) if (!programs.has(program)) problems.push(`starts ${program} without the process permission`);
for (const program of programs) if (!started.has(program)) problems.push(`process permission for ${program}, which the code doesn't start`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`✓ ${manifest.id} ${manifest.version}: ${texts.size} texts translated, ${exported.size} exports, ${network.size} hosts`);
}
