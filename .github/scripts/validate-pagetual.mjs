#!/usr/bin/env node
// Gate for the Pagetual rule files. Dependency-free; used by CI and the upstream sync.
//   files <dir> [--baseline <dir>]  validate items_all.json, pagetualRules.json, version in <dir>
//   live <baseUrl>                  same checks against a deployed site
//   refs                            fail if upstream (hoothin) URLs leak back into the fork's script/README
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = JSON.parse(readFileSync(join(root, "Pagetual/pagetual.schema.json"), "utf8"));
const MAX_SHRINK = 0.10;

const checks = {
    "items_all.json": {
        min: 1000,
        item: x => typeof x?.name === "string" && typeof x?.data?.url === "string" && typeof x?.data?.nextLink === "string",
    },
    "pagetualRules.json": {
        min: 300,
        item: x => x && typeof x === "object" && schema.items.required.every(k => typeof x[k] === "string"),
    },
};

function validate(name, text, baselineText) {
    const errors = [];
    if (name === "version") {
        if (!/^\s*[1-9]\d*\s*$/.test(text)) errors.push(`version is not a positive integer: ${JSON.stringify(text.slice(0, 20))}`);
        return errors;
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return [`${name}: invalid JSON (${e.message}), ${text.length} bytes`]; }
    if (!Array.isArray(data)) return [`${name}: not an array`];
    const { min, item } = checks[name];
    if (data.length < min) errors.push(`${name}: ${data.length} items < floor ${min}`);
    const bad = data.findIndex(x => !item(x));
    if (bad !== -1) errors.push(`${name}: item ${bad} missing required fields: ${JSON.stringify(data[bad]).slice(0, 120)}`);
    if (baselineText != null) {
        const base = JSON.parse(baselineText).length;
        if (data.length < base * (1 - MAX_SHRINK)) errors.push(`${name}: shrank ${base} -> ${data.length} (> ${MAX_SHRINK * 100}%)`);
    }
    if (!errors.length) console.log(`ok  ${name}: ${data.length} items`);
    return errors;
}

async function main([mode, arg, flag, baseline]) {
    const errors = [];
    if (mode === "files") {
        for (const name of [...Object.keys(checks), "version"]) {
            const p = join(arg, name);
            if (!existsSync(p)) { if (name !== "version" || !baseline) errors.push(`${name}: missing`); continue; }
            const b = flag === "--baseline" && name !== "version" && existsSync(join(baseline, name)) ? readFileSync(join(baseline, name), "utf8") : null;
            errors.push(...validate(name, readFileSync(p, "utf8"), b));
        }
    } else if (mode === "live") {
        const base = arg.endsWith("/") ? arg : arg + "/";
        for (const name of [...Object.keys(checks), "version"]) {
            const res = await fetch(base + name + "?" + Date.now());
            if (!res.ok) { errors.push(`${name}: HTTP ${res.status}`); continue; }
            if (res.headers.get("access-control-allow-origin") !== "*") errors.push(`${name}: missing CORS *`);
            errors.push(...validate(name, await res.text()));
        }
    } else if (mode === "refs") {
        const upstream = /hoothin\.github\.io|github\.com\/hoothin\/UserScripts|raw\.githubusercontent\.com\/hoothin|pagetual\.hoothin\.com/;
        const allowed = /^\/\/ @(author|contributionURL)\b|Made with .* by/;
        for (const f of ["Pagetual/pagetual.user.js", "Pagetual/README.md"]) {
            readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
                if (upstream.test(line) && !allowed.test(line.trim())) errors.push(`${f}:${i + 1}: upstream URL: ${line.trim().slice(0, 140)}`);
            });
        }
        if (!errors.length) console.log("ok  no upstream URLs in fork script/README");
    } else {
        errors.push("usage: validate-pagetual.mjs files <dir> [--baseline <dir>] | live <baseUrl> | refs");
    }
    if (errors.length) {
        console.error(errors.map(e => "FAIL " + e).join("\n"));
        process.exit(1);
    }
}

await main(process.argv.slice(2));
