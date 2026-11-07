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
// The release notes of a version come from its changelog entry.
if (!read("CHANGELOG.md").includes(`## [${manifest.version}]`)) problems.push(`CHANGELOG.md has no entry for ${manifest.version}`);
if (pkg.license !== "AGPL-3.0-only" || !source.startsWith("// SPDX-License-Identifier: AGPL-3.0-only")) problems.push("license isn't stated as AGPL-3.0-only in package.json and the source");

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
const reached = new Set([...source.matchAll(/"https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
reached.delete("open.spotify.com"); // links for sharing, never fetched
reached.delete("soloist-builds.spotifycdn.com"); // fetched by curl, not by the plugin
for (const host of reached) if (!network.has(host)) problems.push(`fetches ${host} without the network permission`);
for (const host of network) if (!reached.has(host)) problems.push(`network permission for ${host}, which the code doesn't reach`);

// Programs the code starts are in the process permission.
const programs = manifest.permissions?.process || [];
for (const program of ["curl", "tar"]) if (!programs.includes(program)) problems.push(`starts ${program} without the process permission`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`✓ ${manifest.id} ${manifest.version}: ${texts.size} texts translated, ${exported.size} exports, ${network.size} hosts`);
}
