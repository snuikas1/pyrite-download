# Pyrite 0.2.13 (test build, not released)

Built on 2026-10-14 by Apis (Claude) from the shipped v0.2.12 release zip, because the source code is lost.
Every change is a small, commented edit (`/* Pyrite 0.2.13 (Apis, 2026-10-14): ... */` in the minified files).
Nothing here has been run in a browser yet: only static checks (`node --check`), a sandboxed unit test of the
changed deep-check filter and cert logic, and a comparison of the zip against the folder.

- `build-0.2.13/`: the unpacked build (load `build-0.2.13/extension` unpacked to try the extension alone).
- `pyrite-trial-0.2.13.zip`: same layout as the release zips (`extension/`, `bridge/`, `utils/`, installers).
- Extension ID and manifest `key` are unchanged (`hegfbajilkihmgclmnajpkhckogfplni`).

## Fixes

| # | What was wrong | Since | What changed | File |
|---|---|---|---|---|
| 1 | **Deep check silently dropped story facts about a charity or a donation.** v0.2.12 added a filter that drops any fact whose text contains "fee", "donat…" or "charit…", or the charity's name, whenever Pyrite read the coin's fee routing. For donation-relay coins the charity *is* the story, so the deep check often ended with "There is no checkable story". | v0.2.12 | The fee/charity filter now drops only `coin` facts (Pyrite shows its own fee line for those). Story facts are kept. Red flags are filtered as before. | `extension/background.js` (`gi`) |
| 2 | The prompt told Claude to list no fee, donation **or charity** fact at all, so it also skipped charity stories. | v0.2.12 | Prompt now says: no fact about where *this coin's* fees go; a story about a charity or a donation is still a story fact. | `utils/claude/deep-system-prompt.md` |
| 3 | **Quote filter too brittle.** v0.2.12 drops every fact whose `quote` is not literally in the evidence. A quote shortened with "…" was dropped, and a fact with no `quote` field at all (an older prompt/schema in `utils/claude`, e.g. only the extension folder updated) dropped *every* fact. | v0.2.12 | A quote with an ellipsis is checked piece by piece (each piece must be in the evidence). A fact with no `quote` field is kept. An empty or invented quote is still dropped. | `extension/background.js` (`gi`) |
| 4 | The v0.2.12 "settle" second pass replaced the first answer even when the second came back with no facts. | v0.2.12 | The first answer is kept when the settle answer has no facts and the first had some. | `extension/background.js` (deep runner) |
| 5 | **The fresh "check" button was gone from the panel** (it only appeared as "retry" after a failed check), so a coin could not be re-read past the 30-minute cache. | v0.2.11 | The `check` button ("check this coin again, with a fresh reading") is back beside the deep-check magnifier, as in v0.2.10. "retry" after a failure is unchanged. | `extension/content-scripts/content.js`, `extension/chunks/popup-s249gfzF.js` |
| 6 | Site age of 360-364 days showed as `12mo`. | ≤ v0.2.8 | Months are capped at `11mo`; from 365 days it shows `1y`. | `background.js`, `content.js`, `popup-s249gfzF.js` |
| 7 | The earliest-TLS-cert lookup (aged-domain heuristic) counted certificates of any subdomain (`include_subdomains=true`), so an old `mail.` cert could hide a freshly deployed site. | ≤ v0.2.8 | Only certificates naming the domain itself, `www.` or `*.` count. | `extension/background.js` (certspotter reader) |
| 8 | The Windows installer opened **Chrome** at the end while the bundled CLAUDE.md says the user uses Edge and READ-ME said Chrome. | ≤ v0.2.8 | The installer opens Edge's extensions page (Chrome only when Edge is not installed) and names that browser in its last lines. READ-ME and the bundled CLAUDE.md say Edge, with the Chrome path as a note. | `bridge/install-windows.ps1`, `READ-ME-FIRST.txt`, `CLAUDE.md` |
| 9 | `install-mac.sh` said `uninstall-mac.sh removes the first three`, but no such file ships. | ≤ v0.2.8 | Comment corrected: no uninstaller yet, delete the listed files by hand. | `bridge/install-mac.sh` |
| 10 | Version. | | `0.2.12` → `0.2.13`. | `extension/manifest.json` |

## Checked and rejected

- "Windows-1252 entity table is off": wrong. The table in `background.js` has all 32 slots; the 5 undefined ones are invisible control characters, which made it look 27 long. Verified by code point and by a unit test (`&#130;` → `‚`, `&#150;` → `–`).
- "`claudeOn` on by default spams reconnects": no reconnect loop exists; the native port opens on switch-on or on a deep check only.
- "Pair check returns nothing if one RPC read fails": it returns a grey "pair X: on-chain symbol not read" row per pair; the fake-stock test is skipped for that scan (a silent false negative, not a missing row).

## Not changed (see the vault's Pyrite Fix Log for why)

Redirect validation in the fetch wrapper (a browser `fetch` cannot inspect redirect hops), the baked-in stock list, the
TikTok switch removed in v0.2.12, the v0.2.12 settle pass that can double a deep check's time and plan use, the bridge's
wide "limit reached" text match, the donate.gg cache, and the code-health items (vendored public-suffix list, duplicated code).
The bridge (`bridge/pyrite-bridge.mjs`) is unchanged.
