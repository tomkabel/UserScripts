// Regression test for the 2026-11 onboarding failure: a fresh install must import the
// built-in rules from the guide's first-run page, and still succeed when Pages is down.
//
// Run from any directory that has `playwright` installed:
//   node /path/to/Pagetual/test/onboarding.e2e.mjs [--block-pages]
// Env: CHROME_PATH (optional Chromium binary), GUIDE_URL (default: fork firstRun page).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { chromium } = createRequire(pathToFileURL(process.cwd() + "/").href)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const userscript = readFileSync(join(here, "..", "pagetual.user.js"), "utf8");
const version = userscript.match(/@version\s+(\S+)/)[1];
const guideUrl = process.env.GUIDE_URL || "https://tomkabel.github.io/PagetualGuide/firstRun.html";
const blockPages = process.argv.includes("--block-pages");
const pagesRules = "https://tomkabel.github.io/UserScripts/Pagetual/";

// GM storage lives in Node so it survives the script's location.reload() after import.
// Frozen once onboarding completes, so the post-import reload (a fresh in-page store) can't clobber it.
const store = new Map();
const requests = [];
let frozen = false;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
await page.exposeBinding("__gmSet", (_, k, v) => {
    if (frozen) return;
    store.set(k, v);
    if (k === "rulesData" && v?.uninited === false && (store.get("rules") || []).length) frozen = true;
});
await page.exposeBinding("__gmRequest", async (_, req) => {
    requests.push(req.url);
    if (blockPages && req.url.startsWith(pagesRules)) return { error: "blocked by test" };
    try {
        const res = await fetch(req.url, { method: req.method || "GET" });
        const text = await res.text();
        return { status: res.status, responseText: text, finalUrl: res.url };
    } catch (e) {
        return { error: String(e) };
    }
});
// Same-origin rule URLs are fetched with page fetch, not GM, so block those at the network layer too.
if (blockPages) await page.route(pagesRules + "**", route => route.abort());
const snapshot = () => JSON.stringify(Object.fromEntries(store));
await page.addInitScript(({ code, version, snap }) => {
    const mem = new Map(Object.entries(JSON.parse(snap)));
    window.GM_getValue = (k, d) => (mem.has(k) ? mem.get(k) : d);
    window.GM_setValue = (k, v) => { mem.set(k, v); window.__gmSet(k, v); };
    window.GM_deleteValue = k => { mem.delete(k); window.__gmSet(k, undefined); };
    window.GM_info = { script: { version } };
    window.GM_openInTab = () => {};
    window.GM_notification = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = f => {
        window.__gmRequest({ url: f.url, method: f.method }).then(r => {
            if (r.error) return f.onerror && f.onerror(r);
            f.onload && f.onload({ status: r.status, response: r.responseText, responseText: r.responseText, finalUrl: r.finalUrl });
        });
    };
    document.addEventListener("DOMContentLoaded", () => { (0, eval)(code); });
}, { code: userscript, version, snap: snapshot() });

try {
    await page.goto(guideUrl, { waitUntil: "networkidle" });
    const pre = page.locator("pre[name=pagetual]").first();
    await pre.hover();
    await page.locator("#pagetualImport").first().click();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !frozen) {
        await new Promise(r => setTimeout(r, 500));
    }
    const rulesData = store.get("rulesData") || {};
    const rules = store.get("rules") || [];
    const from = rules.reduce((a, r) => ((a[r.from] = (a[r.from] || 0) + 1), a), {});
    const result = {
        page: page.url(), blockPages, rules: rules.length, byRuleUrlId: from,
        urls: rulesData.urls, ruleVersion: rulesData.ruleVersion, wedata2github: rulesData.wedata2github,
        cdnUsed: requests.some(u => u.startsWith("https://cdn.jsdelivr.net/")),
    };
    console.log(JSON.stringify(result, null, 2));
    const fail = [];
    if (rules.length < 3800 + 600) fail.push(`expected >= 4400 rules, got ${rules.length}`);
    if (rulesData.uninited !== false) fail.push("rulesData still uninited");
    if (!(rulesData.urls || []).some(u => u.url === pagesRules + "pagetualRules.json")) fail.push("pagetualRules.json URL not imported from guide");
    if (!(from[1] >= 3800)) fail.push(`builtin wedata mirror (id 1) gave ${from[1] || 0} rules`);
    if (!(from[2] >= 600)) fail.push(`pagetualRules.json (id 2) gave ${from[2] || 0} rules`);
    if (blockPages && !result.cdnUsed) fail.push("jsDelivr fallback not used");
    if (fail.length) { console.error("FAIL " + fail.join("; ")); process.exitCode = 1; } else console.log("PASS");
} finally {
    await browser.close();
}
