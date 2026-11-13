# Pagetual on ScriptCat: critique and phased plan

Date: 2026-11-13
Subject: `Pagetual/pagetual.user.js` v1.9.37.134 (13,829 lines, 785,238 bytes)
ScriptCat reference: `~/Documents/scriptcat` at `3a584125` (package.json 1.5.1), its `docs/`, `src/`, `example/`, and
`skills/scriptcat-userscript/` (the bundled userscript authoring skill and `check.mjs` linter)

Evidence tags used below: **[S]** read from source/docs, **[R]** observed by running it, **[U]** hypothesis, not yet
checked. Only the two lint results in the Verdict are [R]. Nothing has been run inside ScriptCat yet, so every
runtime claim is [S] or [U].

## Verdict

- Statically valid today. `node skills/scriptcat-userscript/scripts/check.mjs pagetual.user.js` prints `ok`,
  and `node --check` passes [R]. "Valid" is already true at lint level; the checker only covers grants, `@match`,
  `@connect`, cron and `@grant none` misuse, so it says nothing about runtime behaviour.
- "100% working as intended" is unproven. No run of Pagetual inside ScriptCat exists. The plan therefore starts by
  building a judge (Phase 0) and only then edits Pagetual.
- Ranked risks, all [U] until Phase 0 runs: (1) rule JavaScript compiled with `Function` under page CSP,
  (2) the whole GM value store re-read and shipped to every frame on every page load, (3) frame cost from
  `*://*/*` without `@noframes`, (4) charset decoding if anyone adds `fetch`/`anonymous`/`redirect` to a request,
  (5) 4-part version comparison in ScriptCat's update check.

## Part 1. Critique

### Architecture and structure

- One 785 KB IIFE with no module boundary. Everything ships to every matching frame of every site, whether or not
  Pagetual will act there. Lines 101 to 4189 (i18n tables plus compat shims) are 276,947 bytes, 37.3% of the file,
  and are parsed before `function i18n` at line 4190. Only one locale is ever used per page. [S]
- God objects. `RuleParser` is 2,993 lines (line 5010), `Picker` 916, `SideController` 449. `initConfig` is a
  1,016-line function (line 9666), `emuPage` 352, `createPageBar` 328, `initRules` 303, `initListener` 280. None of
  these can be unit-tested in isolation. [S]
- Style debt. 943 `let`, 84 `var`, 89 `const`. 63 `catch` blocks, 11 of them empty, so failures are swallowed.
  103 `addEventListener` vs 29 `removeEventListener` (leak surface). 79 `setTimeout` and 11 `setInterval`, and zero
  `MutationObserver`: dynamic content is detected by polling. Zero tab-indented lines but 103 column-0 lines,
  e.g. lines 108 to 150 are hand-edited with broken indentation. [S]
- Real bug, line 126: `document.readystate` (lowercase s) is always `undefined`, so the "already loaded" branch
  of `pauseVideo` in the child-iframe path can never run. Independent of ScriptCat. [S]
- Dead-browser code in the storage layer (lines 4452 to 4460, 4478 onward): Opera `scriptStorage`, Maxthon
  `mxGetRuntime`. Kept for "all managers" but never isolated from the hot path. [S]

### Userscript-manager integration

- Seven hand-rolled shims (`_GM_xmlhttpRequest`, `_GM_registerMenuCommand`, `_GM_notification`, `_GM_addStyle`,
  `_GM_openInTab`, `_GM_info`, `_GM_setClipboard`, lines 4189 to 4445), each probing `typeof GM_x` then `GM.x` then a
  stub. `GM_info.scriptHandler` is never read, so there is no per-manager branch for known differences
  (for example ScriptCat deletes a key on `GM_setValue(k, undefined)`). [S]
- Storage facade (lines 4447 to 4500) feature-detects by calling `GM_getValue('a','b')` and `GM.getValue('a','b')`
  at startup, writes fire-and-forget, and "clears" a key with `setValue(k, "")` followed by `deleteValue(k)`:
  two messages to the service worker and two broadcasts. Reads go through a callback wrapper and are awaited
  serially at init (about 8 sequential `getData` calls, lines 5026 to 5038 and 11084 to 11104) where one
  batched `GM.getValues` would do. [S]
- Header: 21 `@grant` lines. ScriptCat derives `GM.x` from `GM_x` when the names match exactly, so 10 of the 11
  `GM.*` grants are redundant here. `GM.xmlHttpRequest` genuinely needs its own grant (case differs from
  `GM_xmlhttpRequest`), so the header is correct, just noisy. The `GM.*` lines are required for Tampermonkey and
  Violentmonkey, so do not delete them. [S]
- `@connect`: five named hosts plus `*`. ScriptCat treats `*` as match-all (`gm_api.ts:286`,
  `gm_api.test.ts:43`), so the named hosts are dead weight. `ghproxy.com` and `ghp.ci` are third-party mirrors
  nobody audits. `*` itself is legitimate (next pages can live on any origin) but is undocumented in the file. [S]
- No `@updateURL`/`@downloadURL`. Updates depend on the install URL. The in-page "out of date" tip (line 9873)
  scrapes GitHub README DOM (`.markdown-body>h1[id]`), which breaks on any markup change. [S]
- Version `1.9.37.134` has four components. Whether ScriptCat's update comparison orders it correctly is [U].
- `@icon` is a 1,095-character data URI and the header is 101 lines (30 locale name/description pairs), 8,423
  bytes, parsed by the manager on every metadata read. [S]

### Security posture

- 20 call sites compile rule-supplied strings with `Function`/`AsyncFunction` (lines 5270, 5287, 5388, 6744,
  6773, 6774, 6834, 6880, 7184, 7284, 7359, 7386, 7660, 7868, 11266, 12854, 12932, 13249, 13285, 13479). The
  bundled rule feed (`pagetualRules.json`, 349,425 bytes, 682 rules) carries 220 JS-bearing fields (`init` 91,
  `nextLinkByJs` 44, `pageBarText` 40, `preloadImages` 22, `wait` 12, others 11). Rules are fetched from GitHub
  raw, wedata.net, or user-supplied URLs. A poisoned feed means arbitrary JS on every site the user visits, with no
  allowlist, signature or size cap. [S]
- `@connect *` plus `GM_xmlhttpRequest` plus that execution path is the full chain. ScriptCat's permission model
  does not mitigate it because `*` resolves to `ConnectMatch.ALL`. [S]

### What is right (so the plan does not break it)

- Same-origin requests go through page `fetch`, cross-origin through `GM_xmlhttpRequest` with a `fetch` fallback on
  error (lines 4370 to 4394). Trusted Types handled with a fallback path (lines 4931 to 4934). Child-iframe
  protocol exits early (lines 114 to 150). The shims already tolerate a missing GM API. Do not rewrite these
  blind.

## Part 2. ScriptCat facts the plan depends on

| Fact | Evidence | Tag |
|---|---|---|
| Scripts are wrapped in `with(arguments[0]\|\|this.$){ return(async function(){ ... }).call(this)}`; globals resolve through a Proxy | `docs/references/architecture-execution.md` | S |
| Page scripts register via `chrome.userScripts` in `MAIN` or `USER_SCRIPT` world; default `@inject-into page`; `auto` unsupported | `runtime.ts:1063,1080`, `monaco-editor/langs/*.ts` | S |
| USER_SCRIPT world CSP is `script-src 'self' 'unsafe-inline' 'unsafe-eval' *` | `runtime.ts:1017` | S |
| Whether Pagetual's `Function()` calls land in a world where page CSP applies | not determinable from source alone | U |
| Entire value store is read on every page load and never cached; every write is broadcast to all tabs | `runtime.ts:1622`, `pushValueUpdate` at `runtime.ts:478` | S |
| `@connect *` is `ConnectMatch.ALL`; a host outside a non-empty `@connect` list is refused | `gm_api.ts:286,938-960` | S |
| XHR strategy: fetch only if `fetch`/`redirect`/`anonymous`/stream; else XHR (Firefox bg) or offscreen XHR (Chrome) | `gm_api.ts:1044-1075` | S |
| `fetch_xhr.overrideMimeType` is a no-op, so charset override only works on the XHR path | `pkg/utils/xhr/fetch_xhr.ts:91` | S |
| `GM.xmlHttpRequest` needs its own `@grant`; other `GM.x` follow `GM_x` | `skills/scriptcat-userscript/references/api.md` | S |
| `GM_registerMenuCommand` dedups by `name` unless `individual: true`; `id` updates an entry | same | S |
| `GM_addValueChangeListener`, `GM_getValues/setValues`, `window.onurlchange` exist | same, `scriptcat.d.ts` | S |
| HEAD commit fixes Firefox `GM_xmlhttpRequest` to http URLs failing straight to `onerror` (#1855), so Firefox XHR is still moving | `git log -1` | S |

## Part 3. Phased plan

Rule: no phase edits `pagetual.user.js` until Phase 0 produces a baseline. Every later phase is judged by the
Phase 0 matrix, not by reading the diff.

### Phase 0: build the judge (no Pagetual edits)

Goal: a repeatable run of Pagetual inside real ScriptCat that answers "which features work" with observations.

1. Build ScriptCat: `cd ~/Documents/scriptcat && pnpm install && pnpm run build` (produces `dist/ext`; a stale
   build silently verifies old code, per `docs/verification.md`). Chromium 1243 and Firefox 1543 are already in
   `~/.cache/ms-playwright`.
2. Drive it with ScriptCat's own harness: `node e2e/session.mjs start pagetual`, `node e2e/drive.mjs ...`. Output
   lands in gitignored `e2e/scratch/`. `docs/verification.md` says not to grow the committed suite for one-off
   checks, so 0a is throwaway scratch. If 0a finds at least one defect, 0b promotes it to a repo-owned harness at
   `Pagetual/test/scriptcat/` (Playwright, `--load-extension`, local fixture server).
3. Install `pagetual.user.js` into ScriptCat through the real install path (`e2e/fixtures.ts` has the helper), with
   rule/version URLs pointed at the local fixture server so nothing touches the network.
4. Fixtures, each with a numeric expected result:
   - F1 plain `a[rel=next]`: N pages appended, N pagebars, `history.replaceState` URLs.
   - F2 `window.pagetualRules` injected from the page (the `unsafeWindow` path, lines 5032 to 5036).
   - F3 rules with JS fields (`init`, `nextLinkByJs`, `pageBarText`, `preloadImages`) served under CSP
     `script-src 'self'` and again under `require-trusted-types-for 'script'`. Pass = rule runs, or degrades with one
     explicit message instead of a silent `EvalError`.
   - F4 GBK page with wrong and with missing charset header: text decoded correctly.
   - F5 cross-origin next page on a second port: loads with no permission prompt.
   - F6 iframe mode (`forceState`, `emuPage`), child-iframe handshake, small-iframe early exit.
   - F7 SPA `pushState` navigation.
   - F8 settings persistence across reload and across two tabs (`autoScrollRate`, `loadNowNum`, `customRules`).
   - F9 rule update (`/version` then rules JSON), `ruleLastUpdate`, `GM_notification`.
   - F10 all 10 menu commands present and clickable in ScriptCat's popup and context menu.
   - F11 config-page import handshake (`click2import`, `inConfig`) against an offline stub of `rule.html`.
   - F12 ScriptCat update detection `1.9.37.134` to `1.9.37.135`.
5. Metrics, recorded once as the baseline: code bytes registered per frame
   (`chrome.userScripts.getScripts`), navigation-to-init time on a blank page, value-store size after F1 and F9,
   number of value broadcasts per page view.
6. Matrix: Chromium and Firefox, feature by feature, on the pinned ScriptCat commit.

Exit: a table of features x browsers marked pass/fail with evidence files. This is the real defect list and
replaces every [U] above.

### Phase 1: free hygiene (judge: `check.mjs` exit 0, F12, no matrix regression)

- Fix `document.readystate` to `document.readyState` (line 126).
- Remove the five named `@connect` hosts, keep `*`, add a comment explaining why `*` is required.
- Add a header comment explaining why `@noframes` is not set (child-iframe protocol needs the script in frames).
- Keep every `GM.*` grant (Tampermonkey/Violentmonkey need them). Do not add `@updateURL`/`@downloadURL`
  without checking Greasyfork's policy on them; decide from the F12 result.

### Phase 2: fix what Phase 0 proves broken (ordered by suspicion)

- 2a. Rule-JS execution. Replace the 20 `Function`/`AsyncFunction` sites with one `compileRule(code, argNames)`
  helper (single try/catch, one diagnostic path, argument names in one table). If F3 fails on CSP pages, the
  fallback is, in order: `GM_addElement('script')` (bypasses CSP on Chrome, not Firefox), then a clear one-time
  notice that this rule needs a CSP-exempt manager. `@inject-into content` is not a fix, since `unsafeWindow` then
  stops being the page's `window`.
- 2b. Storage facade. One call to `GM.getValues` at init; awaited writes; drop the `""` plus `delete` double write
  (keep deleting by key); isolate the Opera/Maxthon branches behind a single `legacyStorage()` so they stay
  supported but off the ScriptCat path.
- 2c. Anything else F4 to F11 show red. Each fix lands with the fixture that failed.

### Phase 3: cost (judge: Phase 0 metrics, budgets set after the baseline)

- Only if the baseline shows the value store or code payload dominates init time. Candidates, in order: stop
  persisting the ~350 KB `rules` array in the GM value store (ScriptCat reads the whole store per page load) and
  serve it from `@resource` + `GM_getResourceText` or a lazily fetched cache; load only the active locale from
  `langData`. Both are measured before and after; if the number does not move, revert.

### Phase 4: ScriptCat-native upgrades (feature-detected, no effect on other managers)

- `GM_addValueChangeListener` so a settings toggle in one tab applies in the others without reload (ScriptCat
  already broadcasts the write).
- `GM_registerMenuCommand` options `id` and `autoClose` for the two toggle entries so labels update in place.
- `window.onurlchange` for SPA route changes, replacing ad hoc history watching, only if F7 shows a gap.
- `GM_info.scriptHandler === 'ScriptCat'` branch for the documented quirks (undefined deletes a key).

### Phase 5: structure (conditional, see Decision 1)

- Split into modules with a bundler that still emits the single `pagetual.user.js` plus generated header; extract
  `langData` into per-locale chunks; break `RuleParser` and `initConfig` along the seams F1 to F11 already test.
- Add ScriptCat's userscript ESLint config (`packages/eslint`) as a gate beside `check.mjs`.

### Phase 6: keep it true

- CI job: build pinned ScriptCat, run the Phase 0 matrix on every `pagetual.user.js` change and weekly against
  ScriptCat `main`. Fail on any pass-to-fail transition or a payload/init budget breach.

## Part 4. Definition of done, and what cannot be proven

Done means all of: `check.mjs` exit 0 with no warnings; ScriptCat userscript ESLint clean; the Phase 0 matrix
fully green on ScriptCat (Chromium and Firefox) at the pinned commit; zero Pagetual console errors on the fixtures;
payload and init time within the budgets recorded in Phase 0.

Not provable offline: behaviour of the 682 real-site rules against live sites (they change daily). The plan
covers the engine paths those rules exercise, not each rule. A sampled live run of the top rules is a separate,
flaky signal and must be labelled as such. ScriptCat docs can lag `scriptcat.d.ts`; when they disagree, the types
win (per the bundled skill).

## Part 5. Decisions needed

1. This fork tracks `hoothin/UserScripts`, and upstream edits `pagetual.user.js` almost daily. Phases 1 to 4 are
   small patches that merge cleanly. Phase 5 (modules plus a build) would conflict on every upstream sync, so it
   only makes sense as a permanent fork or an accepted upstream PR. Recommendation: do 0 to 4, defer 5.
2. Keep multi-manager support (Tampermonkey, Violentmonkey, iOS Userscripts, Maxthon, Opera)? Recommendation: keep,
   isolate, and make ScriptCat the tested target.
3. Where the harness lives: ScriptCat's gitignored scratch (throwaway) or `Pagetual/test/scriptcat/` in this
   repo. Recommendation: scratch first, promote only after Phase 0 finds a defect.

## Part 6. Results (2026-11-13, ScriptCat `3a584125`, Chromium 1248)

Judge: `node Pagetual/test/scriptcat/run.mjs` installs the script through ScriptCat's real install page, completes
first-run onboarding by clicking the import button on a stub of the guide page, and runs the fixtures against local
servers (page origin, a second host via `--host-resolver-rules`, and the guide on its own host). CI:
`.github/workflows/pagetual-scriptcat.yml` (pinned commit on change, ScriptCat `main` weekly).

Matrix, current script 16/16. The pre-change script (`HEAD` before this work) fails 3 of them, so the harness
can tell the two apart:

| Fixture | Before | After |
|---|---|---|
| F9 first-run import, F0 inject, F1 rel=next, F5 cross-host, F4 GBK (header / no header), F6 tiny cross-origin frame, F7 SPA, F8 persistence, F10 menus, F12 update detection, M payload budget | pass | pass |
| F3 rule JS under `script-src 'self'` | fail (`EvalError`, rule ignored) | pass |
| F3 rule JS under Trusted Types | fail | pass |
| F13 site toggle: other tab stops live, label flips in place | fail (not implemented) | pass |

What changed in `pagetual.user.js`:

- Phase 1: `document.readyState` typo fixed; unaudited mirrors `ghproxy.com`/`ghp.ci` dropped from `@connect`
  (no code references them); comment on why `@connect *` stays and why there is no `@noframes`. The named hosts stay:
  they save Tampermonkey users a prompt.
- Phase 2a: `Function`/`AsyncFunction` are shadowed inside the IIFE by one `compileRule`. It tries native compile; on
  a CSP/Trusted Types block it defines the function through `GM_addElement('script')` and caches it, else logs one
  CSP notice. All 20 call sites are untouched, so upstream syncs still merge. New grant: `GM_addElement`.
- Phase 4: the disable/enable menu entry re-registers with `id` on ScriptCat/Tampermonkey so its label follows the
  state; `GM_addValueChangeListener("forceState")` applies a site toggle to other open tabs. New grant:
  `GM_addValueChangeListener`.

Corrections to Parts 1 to 3, from running it:

- `@connect *` is present (line 101). Cross-host next pages load via ScriptCat's background XHR with no prompt.
- Charset: a header that contradicts the bytes is not a Pagetual bug; browsers let the header win too. Correct and
  missing headers both decode.
- Small frames: Pagetual exits only in tiny cross-origin frames; same-origin tiny frames run by design.

Skipped by the plan's own conditions, with the measurement:

- 2b storage batching: all serial reads after rules load take 4 ms total.
- Phase 3: script start (~100 ms) and rules-ready (~430 ms after navigation, including upstream's deliberate
  `setTimeout(init, 300)`) are the same with an empty store and with the real 682-rule feed stored. Nothing to win.
- `window.onurlchange`: F7 passes. `scriptHandler` quirk branch: Pagetual never writes `undefined`.
- Phase 5 (modules, ESLint gate): deferred per Decision 1. ScriptCat's ESLint config reports 31 errors, all upstream
  style (26 `no-useless-escape`); none is a bug (`src = src` reloads a frame on purpose). Fixing them would conflict
  with every upstream sync.

Not covered: Firefox. Playwright cannot load an extension into Firefox; covering it needs `web-ext run` plus a
Marionette driver. Live-site behaviour of the 682 rules is out of scope, as stated in Part 4.
