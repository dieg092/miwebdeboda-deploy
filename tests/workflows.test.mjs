import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir).filter((f) => f.endsWith(".yml"));

/** Jobs de un workflow como texto: cada bloque que empieza con «  nombre:» bajo «jobs:». */
function jobs(text) {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  const parts = body.split(/^ {2}(?=[a-z0-9_-]+:\s*$)/m).slice(1);
  return parts.map((p) => ({ name: p.split(":")[0], text: p }));
}

// APP_READ_TOKEN es de solo lectura sobre la app; el resto son secretos de producción.
const SECRETS = /secrets\.(?!APP_READ_TOKEN\b)[A-Z0-9_]+/g;
const CACHE = /^\s*cache:|actions\/cache@|cache-dependency-path:/m;

describe("workflows: los jobs con secretos de producción no restauran cachés", () => {
  it("se encuentran los workflows y sus jobs", () => {
    assert.ok(workflows.includes("monitor-sintetico.yml") && workflows.includes("deploy.yml"));
    const names = jobs(readFileSync(new URL("deploy.yml", dir), "utf8")).map((j) => j.name);
    for (const n of ["verify", "assets", "deploy", "smoke", "record"]) assert.ok(names.includes(n), n);
  });

  for (const f of workflows) {
    for (const job of jobs(readFileSync(new URL(f, dir), "utf8"))) {
      const secrets = [...new Set(job.text.match(SECRETS) ?? [])];
      if (!secrets.length) continue;
      it(`${f} › ${job.name} (${secrets.length} secretos) no usa caché`, () => {
        assert.doesNotMatch(job.text, CACHE, `${f} › ${job.name} usa caché y tiene ${secrets.join(", ")}`);
      });
    }
  }

  it("el detector caza una caché en un job con secretos", () => {
    const bad = "jobs:\n  x:\n    env:\n      A: ${{ secrets.PROD_JWT_SECRET }}\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          cache: pnpm\n";
    const [job] = jobs(bad);
    assert.match(job.text, SECRETS);
    assert.match(job.text, CACHE);
  });
});
