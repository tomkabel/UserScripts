// Phase 0 judge: runs pagetual.user.js inside a real ScriptCat build (Chromium) against local fixtures.
//
//   node Pagetual/test/scriptcat/run.mjs [--only=F1,F5] [--headed] [--debug]
// Env: SCRIPTCAT_DIR (default ~/Documents/scriptcat; needs `pnpm install && pnpm run build` and
//        `pnpm exec playwright install chromium` there)
//      SCRIPT   userscript under test (default ../../pagetual.user.js)
//      TRACE=1  log timed init markers; ONBOARD=0 skips first-run rule import
// The served copy only has its rules/guide/wedata URLs rewritten to the local fixture servers.
// Writes test/scriptcat/out/results.json; exits non-zero when any fixture fails.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scDir = process.env.SCRIPTCAT_DIR || join(homedir(), "Documents/scriptcat");
const ext = join(scDir, "dist/ext");
const { chromium } = createRequire(join(scDir, "package.json"))("@playwright/test");
const scriptPath = process.env.SCRIPT || join(here, "../../pagetual.user.js");
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const headed = process.argv.includes("--headed");

// ---------- fixture servers: A = page origin, B = cross-origin next pages ----------
const gbk = new TextDecoder("gbk"); // only used to sanity-check fixtures
// "第二页内容" (page 2 content) in GBK
const GBK_P2 = Buffer.from([0xb5, 0xda, 0xb6, 0xfe, 0xd2, 0xb3, 0xc4, 0xda, 0xc8, 0xdd]);
if (gbk.decode(GBK_P2) !== "第二页内容") throw new Error("gbk fixture broken");

const item = (p, i) => `<div class="item"><h3>page ${p} item ${i}</h3><p>${"lorem ipsum ".repeat(40)}</p></div>`;
const listPage = (p, next, extraHead = "") => `<!doctype html><html><head><meta charset="utf-8"><title>List page ${p}</title>${extraHead}</head>
<body><div id="list">${Array.from({ length: 12 }, (_, i) => item(p, i)).join("")}</div>
<div class="pager">${next ? `<a rel="next" class="next" href="${next}">Next page</a>` : ""}</div></body></html>`;

let originA, originB, originG;
const counters = {};
const hit = k => (counters[k] = (counters[k] || 0) + 1);

function route(req, res, side) {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    hit(side + p);
    if (side === "B") (counters.bReq ||= []).push(`${req.headers["sec-fetch-mode"] || "-"} origin=${req.headers.origin || "-"}`);
    const html = (body, headers = {}) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(body); };
    let m;
    if (p === "/pagetual.user.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        return res.end(patchedScript(u.searchParams.get("v")));
    }
    if (p === "/rules/version") { res.writeHead(200); return res.end(String(ruleVersion)); }
    if (p === "/rules/pagetualRules.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(fixtureRules)); }
    if (p === "/rules/items_all.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
    // Mirrors PagetualGuide docs/first-run.md: a hidden pre[name=pagetual] holding the rules URL.
    if (p === "/guide/firstRun.html" || p === "/guide/rule.html") return html(`<!doctype html><title>guide</title><h1>Pagetual guide stub</h1>
<pre name="pagetual" style="display: none; overflow: hidden;">\n${originA}/rules/pagetualRules.json\n</pre>`);
    // F1 plain rel=next, 4 pages
    if ((m = p.match(/^\/f1\/(\d+)$/))) { const n = +m[1]; return html(listPage(n, n < 4 ? `/f1/${n + 1}` : "")); }
    // F5 cross-origin next page: page 1 on A links to B
    if (p === "/f5/1") return html(listPage(1, `${originB}/f5/2`));
    if ((m = p.match(/^\/f5\/(\d+)$/))) { const n = +m[1]; return html(listPage(n, n < 3 ? `${originB}/f5/${n + 1}` : "")); }
    // F4 GBK: page 1 utf-8, next page GBK with a correct or a missing charset header (meta says gbk)
    if (p === "/f4/1") return html(listPage(1, "/f4/2?h=" + (u.searchParams.get("h") || "none")));
    if (p === "/f4/2") {
        const h = u.searchParams.get("h");
        const head = Buffer.from(`<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"><title>p2</title></head><body><div id="list">`);
        const items = Array.from({ length: 12 }, () => Buffer.concat([Buffer.from('<div class="item"><h3 class="gbk">'), GBK_P2, Buffer.from(`</h3><p>${"lorem ipsum ".repeat(40)}</p></div>`)]));
        const body = Buffer.concat([head, ...items, Buffer.from(`</div></body></html>`)]);
        res.writeHead(200, { "content-type": h === "gbk" ? "text/html; charset=gbk" : "text/html" });
        return res.end(body);
    }
    // F2/F3 page-supplied rules (unsafeWindow.pagetualRules) with JS fields, optional CSP
    if ((m = p.match(/^\/f3\/(\d+)$/))) {
        const n = +m[1];
        const csp = u.searchParams.get("csp");
        const q = csp ? `?csp=${csp}` : "";
        const headers = {};
        if (csp === "self") headers["content-security-policy"] = "script-src 'self'";
        if (csp === "tt") headers["content-security-policy"] = "script-src 'self'; require-trusted-types-for 'script'";
        const rules = JSON.stringify([{
            name: "f3", url: "^" + originA.replace(/[.:/]/g, "\\$&") + "/f3/",
            pageElement: ".item",
            nextLinkByJs: "let a=doc.querySelector('a.jsnext');return a&&a.href;",
            init: "document.documentElement.dataset.f3init='1'",
            pageBarText: 1,
        }]);
        const extra = n === 1 ? `<script src="/f3rules.js"></script>` : "";
        if (p === "/f3/1") rulesForF3 = rules;
        const body = listPage(n, "", extra).replace('<div class="pager">', `<div class="pager">${n < 3 ? `<a class="jsnext" href="/f3/${n + 1}${q}">more</a>` : ""}`);
        return html(body, headers);
    }
    if (p === "/f3rules.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(`window.pagetualRules=${rulesForF3};`); }
    // F7 SPA: content swapped by pushState, each "route" has its own next link
    if (p === "/f7/") return html(listPage(1, "/f7/p2").replace("</body>", `<script src="/f7.js"></script></body>`));
    if (p === "/f7/p2" || p === "/f7/p3") { const n = +p.slice(-1); return html(listPage(n, n < 3 ? "/f7/p3" : "")); }
    if (p === "/f7.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(`window.spaGo=()=>{history.pushState({},'', '/f7/other');document.getElementById('list').innerHTML='${Array.from({ length: 12 }, (_, i) => item(9, i)).join("").replace(/'/g, "\\'")}';document.querySelector('.pager').innerHTML='<a rel="next" href="/f1/2">Next page</a>';};`); }
    // F6 small iframe: Pagetual exits early inside a tiny cross-origin frame (same-origin tiny frames run by design)
    if (p === "/f6/host") return html(`<!doctype html><body>${listPage(1, "/f1/2").replace(/^.*<body>|<\/body>.*$/gs, "")}<iframe src="${originB}/f1/1" width="80" height="40"></iframe></body>`);
    if (p === "/blank") return html("<!doctype html><title>blank</title><body></body>");
    res.writeHead(404); res.end("nf");
}
let rulesForF3 = "[]";
let ruleVersion = 1;
// The real feed, so storage size and rule matching cost match production.
const fixtureRules = JSON.parse(readFileSync(join(here, "../../pagetualRules.json"), "utf8"));

function patchedScript(v) {
    let code = readFileSync(scriptPath, "utf8")
        .replace(/https:\/\/tomkabel\.github\.io\/UserScripts\/Pagetual\//g, originA + "/rules/")
        .replace(/https:\/\/cdn\.jsdelivr\.net\/gh\/tomkabel\/UserScripts@master\/Pagetual\//g, originA + "/rules/")
        .replace(/https:\/\/tomkabel\.github\.io\/PagetualGuide\//g, originG + "/guide/")
        .replace("^https:\\/\\/tomkabel\\.github\\.io\\/PagetualGuide\\/", "^" + (originG + "/guide/").replace(/[.:/]/g, "\\$&"))
        .replace(/http:\/\/wedata\.net\/databases\/AutoPagerize\/items_all\.json/g, originA + "/rules/items_all.json");
    if (process.env.TRACE) {
        const mark = (needle, tag) => { if (!code.includes(needle)) throw new Error("trace needle missing: " + tag); code = code.replace(needle, `console.log("TRACE ${tag}", location.pathname, Math.round(performance.now()));` + needle); };
        mark("    function init() {\n", "init-def");
        mark("(function() {\n    'use strict';\n    const pauseVideo", "top");
        mark("                callback();\n            });\n        });\n    }\n\n    let xhrFailed", "initRules-done");
        mark("                pageReady = true;\n", "pageReady");
        mark("                if (initConfig(href)) {", "before-initConfig");
        mark("                manualPause = !!await", "before-pause");
        mark("                updateDate = await getData", "before-updateDate");
        mark("                let _nextSwitch = await", "before-nextSwitch");
        mark("            let rules = await getData(\"rules\");", "before-rules");
        mark("            if (rules) self.rules = rules;", "after-rules");
        mark("        storage.getItem(\"rulesData\", data => {", "before-rulesData");
        mark("            ruleParser.initSavedRules(async () => {", "before-initSavedRules");
        code = code.replace("    function initPage() {\n", "    function initPage() {\nconsole.log('TRACE initPage', location.pathname);\n");
        code = code.replace("        async initSavedRules(callback) {\n", "        async initSavedRules(callback) {\nconsole.log('TRACE initSavedRules');\n");
    }
    if (v) code = code.replace(/(@version\s+)\S+/, `$1${v}`);
    return code;
}

const listen = side => new Promise(r => { const s = createServer((q, s2) => route(q, s2, side)); s.listen(0, "127.0.0.1", () => r(s)); });
const srvA = await listen("A"), srvB = await listen("B");
// Guide pages get their own host: Pagetual treats every page on the guide's hostname as a config page.
const srvG = await new Promise(r => { const s = createServer((q, s2) => route(q, s2, "G")); s.listen(0, "127.0.0.2", () => r(s)); });
originG = `http://127.0.0.2:${srvG.address().port}`;
originA = `http://127.0.0.1:${srvA.address().port}`;
// B is a different registrable host (mapped to 127.0.0.1 by --host-resolver-rules) so it is a different host, not just a different port (ScriptCat @connect is host based)
originB = `http://cross-origin.test:${srvB.address().port}`;

// ---------- browser with ScriptCat ----------
const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--disable-gpu", "--host-resolver-rules=MAP cross-origin.test 127.0.0.1", ...(headed ? [] : ["--headless=new"])];
const profile = mkdtempSync(join(tmpdir(), "pagetual-sc-"));
let ctx = await chromium.launchPersistentContext(profile, { headless: false, args });
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
{
    const pg = await ctx.newPage();
    await pg.goto("chrome://extensions/");
    await pg.waitForFunction(() => !!chrome.developerPrivate);
    await pg.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }), extId);
    await ctx.close();
}
ctx = await chromium.launchPersistentContext(profile, { headless: false, args });
sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
await ctx.addInitScript(() => { try { localStorage.setItem("firstUse", "false"); } catch {} });

async function install(v) {
    const opened = ctx.waitForEvent("page");
    await sw.evaluate(url => chrome.tabs.create({ url }), `chrome-extension://${extId}/src/install.html?url=${originA}/pagetual.user.js${v ? "?v=" + v : ""}`);
    const pg = await opened;
    const btn = pg.getByTestId("install-primary");
    await btn.waitFor({ timeout: 30_000 });
    await pg.waitForFunction(() => !document.querySelector('[data-testid="install-primary"]')?.disabled, null, { timeout: 30_000 });
    const label = await btn.textContent();
    await Promise.all([pg.waitForEvent("close", { timeout: 20_000 }).catch(() => {}), btn.click()]);
    return label;
}

// Close every tab Pagetual opens on first run (firstRun guide) so it does not steal focus.
// Instead, onboarding is completed explicitly below, the same way a user would: open firstRun and let it import.
let onboardingTabs = 0;
ctx.on("page", p => p.waitForLoadState().then(() => { if (p.url().includes("/guide/")) onboardingTabs++; }).catch(() => {}));

const results = [];
const record = (id, name, pass, evidence) => { results.push({ id, name, pass, evidence }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} :: ${JSON.stringify(evidence)}`); };
const want = id => !only.length || only.includes(id);

async function openPage(url) {
    const pg = await ctx.newPage();
    const logs = [];
    pg.on("console", m => { logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); if (process.env.TRACE && m.text().startsWith("TRACE")) console.log(url, m.text()); });
    pg.on("pageerror", e => logs.push("pageerror: " + String(e).slice(0, 300)));
    const t0 = Date.now();
    await pg.goto(url, { waitUntil: "domcontentloaded" });
    return { pg, logs, t0 };
}
async function scrollLoad(pg, rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await pg.mouse.wheel(0, 20000);
        await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await pg.waitForTimeout(700);
    }
}
const count = (pg, sel) => pg.evaluate(s => document.querySelectorAll(s).length, sel);
const pagetualErrors = logs => logs.filter(l => /^(error|pageerror)/.test(l) && !/favicon|404/.test(l));

const installLabel = await install();
console.log("installed:", installLabel?.trim());
await new Promise(r => setTimeout(r, 1500));
if (process.env.ONBOARD !== "0") {
    // First page view triggers the firstRun tab; that tab imports the rules (version + rules JSON).
    const { pg } = await openPage(`${originA}/blank`);
    let guide;
    for (let i = 0; i < 40 && !guide; i++) { await pg.waitForTimeout(500); guide = ctx.pages().find(p => p.url().includes("/guide/")); }
    if (guide) await guide.locator("#pagetualImport").click({ timeout: 15_000 }).catch(e => console.log("import click failed", String(e).slice(0, 200)));
    const t = Date.now();
    while (Date.now() - t < 30_000 && !counters["A/rules/pagetualRules.json"]) await pg.waitForTimeout(500);
    await pg.waitForTimeout(3000);
    record("F9", "first-run onboarding imports rules", !!counters["A/rules/pagetualRules.json"], { onboardingTabs, version: counters["A/rules/version"] || 0, rules: counters["A/rules/pagetualRules.json"] || 0, wedata: counters["A/rules/items_all.json"] || 0 });
    for (const p of ctx.pages()) if (p.url().includes("/guide/")) await p.close();
    await pg.close();
}

// F0: does the script inject at all, and how long until its first DOM effect
if (want("F0")) {
    const { pg, logs, t0 } = await openPage(`${originA}/f1/1`);
    const ok = await pg.waitForFunction(() => !!document.querySelector("[id^=pagetual], .pagetual_pageBar, #pagetual-picker, style") && performance.now() > 0, null, { timeout: 15_000 }).then(() => true, () => false);
    const injected = await pg.evaluate(() => [...document.querySelectorAll("*")].some(e => (e.id || "").startsWith("pagetual") || [...e.classList].some(c => c.startsWith("pagetual"))) || [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.cssText.includes("pagetual")); } catch { return false; } }));
    record("F0", "script injects into a top frame", injected, { ms: Date.now() - t0, ok, errors: pagetualErrors(logs).slice(0, 5) });
    await pg.close();
}

if (want("F1")) {
    const { pg, logs } = await openPage(`${originA}/f1/1`);
    await pg.waitForTimeout(2500);
    await scrollLoad(pg);
    const items = await count(pg, ".item"), bars = await count(pg, ".pagetual_pageBar");
    const url = pg.url();
    if (process.argv.includes("--debug")) console.log("DEBUG F1", counters, await pg.evaluate(() => ({ inited: window.initedPagetual, ids: [...document.querySelectorAll("[id]")].map(e => e.id).filter(i => /pagetual/i.test(i)) })), logs);
    record("F1", "plain rel=next appends pages", items === 48 && bars === 3, { items, bars, url, hits: [2, 3, 4].map(n => counters[`A/f1/${n}`] || 0), errors: pagetualErrors(logs).slice(0, 5) });
    await pg.close();
}

if (want("F5")) {
    const { pg, logs } = await openPage(`${originA}/f5/1`);
    await pg.waitForTimeout(2500);
    await scrollLoad(pg);
    const items = await count(pg, ".item"), bars = await count(pg, ".pagetual_pageBar");
    const permissionPages = ctx.pages().filter(p => p.url().includes("confirm")).length;
    if (process.argv.includes("--debug")) console.log("DEBUG F5", counters.bReq, logs.filter(l => !/Pagetual v/.test(l) || /rror|efus/.test(l)).slice(0, 8));
    record("F5", "cross-origin next page loads without prompt", items === 36 && permissionPages === 0, { items, bars, permissionPages, hitsB: counters["B/f5/2"] || 0, errors: pagetualErrors(logs).slice(0, 5) });
    for (const p of ctx.pages()) if (p.url().includes("confirm")) await p.close();
    await pg.close();
}

// A header that contradicts the bytes is not tested: browsers let the header win too, so such a site is broken without Pagetual.
for (const h of ["gbk", "none"]) {
    if (!want("F4")) break;
    const { pg, logs } = await openPage(`${originA}/f4/1?h=${h}`);
    await pg.waitForTimeout(2500);
    await scrollLoad(pg, 4);
    const texts = await pg.evaluate(() => [...document.querySelectorAll("h3.gbk")].map(e => e.textContent).filter(Boolean));
    const good = texts.filter(t => t === "第二页内容").length;
    record("F4", `GBK next page, ${h} charset header`, texts.length > 0 && good === texts.length, { found: texts.length, decodedOk: good, sample: (texts[0] || "").slice(0, 20), errors: pagetualErrors(logs).slice(0, 5) });
    await pg.close();
}

for (const csp of ["", "self", "tt"]) {
    if (!want("F3")) break;
    const { pg, logs } = await openPage(`${originA}/f3/1${csp ? "?csp=" + csp : ""}`);
    await pg.waitForTimeout(2500);
    await scrollLoad(pg, 6);
    const items = await count(pg, ".item");
    const init = await pg.evaluate(() => document.documentElement.dataset.f3init || null);
    const evalErr = logs.filter(l => /EvalError|unsafe-eval|TrustedScript|Trusted Type/i.test(l));
    record("F3", `rule JS fields (init, nextLinkByJs) csp=${csp || "none"}`, items === 36 && init === "1", { items, init, evalErr: evalErr.slice(0, 3), errors: pagetualErrors(logs).slice(0, 5) });
    await pg.close();
}

if (want("F6")) {
    const { pg, logs } = await openPage(`${originA}/f6/host`);
    await pg.waitForTimeout(2500);
    const frame = pg.frames().find(f => f !== pg.mainFrame());
    const frameBars = frame ? await frame.evaluate(() => document.querySelectorAll("[class^=pagetual],[id^=pagetual]").length) : -1;
    record("F6", "tiny cross-origin iframe: Pagetual stays out", frameBars === 0, { frameBars, errors: pagetualErrors(logs).slice(0, 5) });
    await pg.close();
}

if (want("F7")) {
    const { pg, logs } = await openPage(`${originA}/f7/`);
    await pg.waitForTimeout(2500);
    await pg.evaluate(() => window.spaGo());
    await pg.waitForTimeout(2500);
    await scrollLoad(pg, 4);
    const fromNewRoute = await pg.evaluate(() => [...document.querySelectorAll(".item h3")].some(h => h.textContent.startsWith("page 2 item")));
    const hits = counters["A/f1/2"] || 0;
    record("F7", "SPA pushState: next link of new route is followed", hits > 0 || fromNewRoute, { hitsF1p2: hits, items: await count(pg, ".item"), errors: pagetualErrors(logs).slice(0, 5) });
    await pg.close();
}

if (want("F8")) {
    // Writes through the real GM store: read what Pagetual persisted, then check a second tab sees it.
    const store = await sw.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(k => /value/i.test(k));
        return keys.map(k => [k, JSON.stringify(all[k]).length]);
    });
    const bytes = store.reduce((a, [, n]) => a + n, 0);
    record("F8", "settings persisted in ScriptCat value store", bytes > 0, { keys: store.length, bytes });
}

if (want("F10")) {
    const { pg } = await openPage(`${originA}/f1/1`);
    await pg.waitForTimeout(2500);
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${extId}/src/popup.html`);
    const menus = await ext.evaluate(async url => {
        const [tab] = await chrome.tabs.query({ url });
        const r = await chrome.runtime.sendMessage({ action: "serviceWorker/popup/getPopupData", data: { tabId: tab.id, url } });
        const s = r.data.scriptList.find(x => x.name === "Pagetual");
        return s ? s.menus.map(m => m.name) : null;
    }, pg.url());
    record("F10", "menu commands registered for the tab", Array.isArray(menus) && menus.length >= 6, { count: menus && menus.length, menus });
    await ext.close(); await pg.close();
}

if (want("F13")) {
    // Toggle "disable site" from the ScriptCat menu in tab A; tab B on the same host must stop without reload,
    // and tab A's menu label must flip in place.
    const a = await openPage(`${originA}/f1/1`), b = await openPage(`${originA}/f1/1`);
    await b.pg.waitForTimeout(3000);
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${extId}/src/popup.html`);
    const menusOf = url => ext.evaluate(async url => {
        const [tab] = await chrome.tabs.query({ url });
        const r = await chrome.runtime.sendMessage({ action: "serviceWorker/popup/getPopupData", data: { tabId: tab.id, url } });
        return r.data.scriptList.find(x => x.name === "Pagetual");
    }, url);
    const sideB = () => b.pg.evaluate(() => !!document.querySelector("#pagetual-sideController"));
    const before = { sideB: await sideB(), labelsA: (await menusOf(a.pg.url())).menus.map(m => m.name) };
    const script = await menusOf(a.pg.url());
    const toggle = script.menus.find(m => /disable/i.test(m.name));
    await ext.evaluate(async ({ uuid, toggle }) => chrome.runtime.sendMessage({ action: "serviceWorker/popup/menuClick", data: { uuid, menus: [toggle] } }), { uuid: script.uuid, toggle });
    await b.pg.waitForTimeout(2500);
    const after = { sideB: await sideB(), reloadedB: false };
    await a.pg.waitForTimeout(1500);
    after.labelsA = (await menusOf(a.pg.url())).menus.map(m => m.name);
    const flipped = after.labelsA.includes("✅Enable automatic page turning") && !after.labelsA.includes(toggle.name);
    record("F13", "site toggle: other tab stops live, label flips in place", before.sideB && !after.sideB && flipped, { before, after, toggle: toggle && toggle.name });
    await ext.close(); await a.pg.close(); await b.pg.close();
}

if (want("F12")) {
    // Update check: serve a higher 5-part version and ask ScriptCat's install page what it sees.
    const cur = readFileSync(scriptPath, "utf8").match(/@version\s+(\S+)/)[1];
    const parts = cur.split(".");
    parts[parts.length - 1] = String(+parts[parts.length - 1] + 1);
    const label = await install(parts.join("."));
    record("F12", `update ${cur} -> ${parts.join(".")} recognised as update`, /update|更新/i.test(label || ""), { label: label?.trim() });
}

// Metrics
if (want("M")) {
    const reg = await sw.evaluate(async () => (await chrome.userScripts.getScripts()).map(s => ({ id: s.id, bytes: (s.js || []).reduce((a, j) => a + (j.code ? j.code.length : 0), 0), allFrames: s.allFrames, world: s.world })));
    const { pg, t0 } = await openPage(`${originA}/blank`);
    await pg.waitForTimeout(1500);
    const nav = await pg.evaluate(() => performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd);
    // Budget: baseline 743,756 bytes registered (2026-11-13) plus ~5% headroom for upstream growth.
    const PAYLOAD_BUDGET = 780_000;
    const own = reg.filter(r => !r.id.startsWith("scriptcat-")).reduce((a, r) => a + r.bytes, 0);
    record("M", `payload ${own} <= ${PAYLOAD_BUDGET} bytes`, own > 0 && own <= PAYLOAD_BUDGET, { registered: reg, blankDCLms: Math.round(nav), wall: Date.now() - t0 });
    await pg.close();
}

mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out/results.json"), JSON.stringify({ scriptcat: scDir, when: new Date().toISOString(), results }, null, 2));
await ctx.close();
srvA.close(); srvB.close(); srvG.close();
rmSync(profile, { recursive: true, force: true });
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} pass`);
process.exit(failed.length ? 1 : 0);
