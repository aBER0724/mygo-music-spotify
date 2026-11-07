# Changelog

Versions follow [Semantic Versioning](https://semver.org).

## [0.4.2] - 2026-11-08

### Added

- Licensed under AGPL-3.0-only, and published at https://github.com/starriv/mygo-music-spotify, where each new version on `main` is released with `plugin.zip` by CI.

### Changed

- The project is laid out as `src/` (the plugin, `main` in plugin.json), `test/` (tests by area, with shared fakes), `scripts/` (checks and packaging) and `locales/`. `plugin.zip` is built by Node alone, byte for byte the same from the same sources, and now carries the changelog. Nothing changes for the listener.

## [0.4.1] - 2026-11-08

### Fixed

- Signing in again while a browser sign-in is still waiting reuses it, instead of failing on the busy redirect port for minutes.
- Spotify Soloist starts again if it stops after it was ready, instead of every later play failing until MyGo Music restarts.
- A passing network error while waiting for Soloist to be paired no longer stops it.
- A play keeps within the 25 seconds before MyGo Music gives up on it, so its own message, not a timeout, reaches the listener.
- Album, artist and podcast pages load even when Spotify can't say whether they're saved or followed.
- Descriptions with invalid character references, local files with malformed IDs, and paging that returns empty pages no longer break a page.
- Reads that meet a passing Spotify server error (502, 503, 504) are tried once more.
- Lyrics missing only because a source was unreachable are looked up again later.
- Soloist's download has a time limit and retries, and a download cut short is fetched again.
- The device menu offers Soloist only when a Soloist key is set and the computer is supported.
- Soloist is recognized by its Spotify device ID, so another computer's Soloist of the same name on the same account isn't taken for this one.

### Added

- `npm run verify` checks that the manifest, package, translations and permissions agree with the code; CI runs it, and tagging a version publishes `plugin.zip`.

## [0.4.0] - 2026-11-08

### Added

- Synced lyrics from LRCLIB and NetEase Cloud Music, matched by title, artist and length, with Chinese translations of songs in other languages when NetEase has them.

## [0.3.1] - 2026-11-08

### Added

- Saving a Soloist key starts Soloist at once, so it can be paired before the first play. The key's help says how to pair.

### Fixed

- A remembered device that's gone is forgotten instead of being tried before every play.

## [0.3.0] - 2026-11-08

### Changed

- The built-in player is Spotify Soloist, Spotify's own headless player, downloaded from Spotify on first use. librespot, which Spotify refuses audio keys for on newer accounts, is gone.

## [0.2.0] - 2026-11-08

### Added

- A built-in player, librespot, for playing without a Spotify app open.

### Fixed

- A play sent to an offline device that Spotify still lists as active is detected, and goes to another open Spotify app.

## [0.1.0] - 2026-11-08

### Added

- Search, home, top tracks, recently played, liked songs, saved albums, podcasts, playlists and their editing, and playback through Spotify Connect, with PKCE sign-in using the listener's own Client ID.
