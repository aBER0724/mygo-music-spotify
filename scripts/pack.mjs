// Builds dist/plugin.zip: what MyGo Music installs, and nothing else (no
// tests, no session data, no downloaded Soloist). No dependencies: a ZIP
// is written here with Node's zlib. Entries carry a fixed time, so the same
// sources always make the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
const files = ["plugin.json", manifest.main, "locales/zh-CN.json", "README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
const FILE_MODE = 0o100644; // a regular file, rw-r--r--

const locals = [];
const centrals = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(new URL(name, root));
  const packed = deflateRawSync(data, { level: 9 });
  const path = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(path.length, 26);
  locals.push(local, path, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below counts
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(path.length, 28);
  central.writeUInt32LE(FILE_MODE * 0x10000, 38); // external attributes
  central.writeUInt32LE(offset, 42);
  centrals.push(central, path);

  offset += local.length + path.length + packed.length;
}

const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(new URL("dist/", root), { recursive: true });
const destination = new URL(`dist/plugin.zip`, root);
writeFileSync(destination, Buffer.concat([...locals, directory, end]));
console.log(`${destination.pathname} (${manifest.id} ${manifest.version}, ${files.length} files)`);
