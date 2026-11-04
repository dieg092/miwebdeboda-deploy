import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Refused, SKIP_RE, deployedOrBootstrap, fingerprint, parseApprovals, protectedMatcher, testWeakenings, verify } from "../scripts/verify-deployable.mjs";

const PROTECTED = readFileSync(new URL("../protegido.txt", import.meta.url), "utf8");
const SIN_CI = readFileSync(new URL("../sin-ci.txt", import.meta.url), "utf8");
const isProtected = protectedMatcher(PROTECTED);
const s = (c) => c.repeat(40);
const HEAD = s("a"), BASE = s("b"), MID = s("c");

const TREE = [
  { path: ".github/workflows/ci.yml", type: "blob", sha: "1" },
  { path: "package.json", type: "blob", sha: "2" },
  { path: "pnpm-lock.yaml", type: "blob", sha: "3" },
  { path: "playwright.config.ts", type: "blob", sha: "4" },
  { path: "prisma/migrations/2026_x/migration.sql", type: "blob", sha: "5" },
  { path: "e2e/global-setup.ts", type: "blob", sha: "6" },
  { path: "e2e/rsvp.spec.ts", type: "blob", sha: "7" },
  { path: "src/app/page.tsx", type: "blob", sha: "8" },
  { path: "src/lib/x.test.ts", type: "blob", sha: "9" },
];
const FP = fingerprint(TREE, isProtected).fingerprint;

const owner = { login: "o", type: "User" };
const upd = (before, after, actor = owner, activity_type = "push") => ({ before, after, actor, activity_type });
/** Actividad de main por defecto: el propietario llevó main de e → d → BASE → MID → HEAD (la más reciente primero). */
const ACTIVITY = [upd(MID, HEAD), upd(BASE, MID, owner, "pr_merge"), upd(s("d"), BASE), upd(s("e"), s("d"))];

/** API de GitHub falsa: HEAD de main, runs de CI, árbol, deployments, comparaciones y actividad de main. */
function fakeApi({ head = HEAD, runs, tree = TREE, deployed = BASE, compare = {}, activity = ACTIVITY } = {}) {
  const calls = [];
  const api = async (p) => {
    calls.push(p);
    if (p.startsWith("repos/o/app/activity?")) return activity;
    if (p.endsWith("/commits/main")) return { sha: head };
    if (p.includes("/actions/workflows/ci.yml/runs"))
      return { workflow_runs: runs ?? [{ head_sha: head, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", conclusion: "success" }] };
    if (p.includes("/git/trees/")) return { tree, truncated: false };
    if (p.includes("/deployments?")) return deployed ? [{ id: 1, payload: { app_sha: deployed } }] : [];
    if (p.includes("/deployments/1/statuses")) return [{ state: "success" }];
    const m = p.match(/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})/);
    if (m) {
      const c = compare[`${m[1]}...${m[2]}`] ?? { status: "ahead", files: [] };
      return p.includes("page=2") || p.includes("page=3") ? { ...c, files: [] } : c;
    }
    throw new Error(`ruta no simulada: ${p}`);
  };
  return { api, calls };
}

const run = (opts = {}, args = {}) =>
  verify({
    api: fakeApi(opts).api,
    appRepo: "o/app",
    deployRepo: "o/deploy",
    requested: args.requested ?? "",
    protectedText: PROTECTED,
    approvalsText: args.approvals ?? `huella ${FP} 2026-11-04 aaaa`,
    bootstrapBase: args.bootstrap ?? s("e"),
    ciIgnoredText: SIN_CI,
    log: () => {},
  });

describe("protegido.txt: costuras de src/ con la CI", () => {
  it("protege el guard de BD, los desvíos a simuladores y sus tests, pero no el resto de src/", () => {
    for (const f of ["src/helpers/db/assertNotProductionDatabase.ts", "src/helpers/aws/s3-endpoint.ts", "src/lib/email/resend-api.ts", "src/lib/ai/cloudflare-api.ts", "src/lib/email/resend-api.test.ts"])
      assert.equal(isProtected(f), true, f);
    for (const f of ["src/lib/ai/cloudflareEmbeddings.ts", "src/app/page.tsx", "src/lib/x.test.ts"]) assert.equal(isProtected(f), false, f);
  });
});

describe("registro de despliegues: se lee con el token del propio repositorio", () => {
  // APP_READ_TOKEN no ve miwebdeboda-deploy (a propósito): los deployments van con GITHUB_TOKEN
  const appOnly = (opts) => {
    const { api } = fakeApi(opts);
    return async (p) => {
      if (p.includes("/deployments")) throw new Refused("GitHub respondió 404 a deployments");
      return api(p);
    };
  };
  it("verify usa deployApi para el registro y api para la app", async () => {
    const r = await verify({
      api: appOnly(),
      deployApi: fakeApi({ deployed: MID }).api,
      appRepo: "o/app",
      deployRepo: "o/deploy",
      requested: "",
      protectedText: PROTECTED,
      approvalsText: `huella ${FP} 2026-11-04 aaaa`,
      bootstrapBase: s("e"),
      ciIgnoredText: SIN_CI,
      log: () => {},
    });
    assert.equal(r.base, MID);
  });
  it("rechaza un re-run con una versión antigua de este repositorio", async () => {
    const base = { api: fakeApi().api, appRepo: "o/app", deployRepo: "o/deploy", requested: "", protectedText: PROTECTED, approvalsText: `huella ${FP} 2026-11-04 aaaa`, bootstrapBase: s("e"), ciIgnoredText: SIN_CI, log: () => {} };
    // fakeApi responde HEAD (a) a cualquier commits/main, también al del repositorio de despliegue
    assert.equal((await verify({ ...base, runningSha: HEAD })).sha, HEAD);
    await assert.rejects(verify({ ...base, runningSha: s("9") }), /no lo relances/);
  });
  it("deployedOrBootstrap: último desplegado con éxito, o la base inicial si aún no hay ninguno", async () => {
    assert.equal(await deployedOrBootstrap(fakeApi({ deployed: MID }).api, "o/deploy", s("e")), MID);
    assert.equal(await deployedOrBootstrap(fakeApi({ deployed: null }).api, "o/deploy", s("e")), s("e"));
    await assert.rejects(deployedOrBootstrap(fakeApi({ deployed: null }).api, "o/deploy", "no-sha"), Refused);
  });
});

describe("verify: quién y qué se despliega", () => {
  it("acepta el HEAD de main con CI verde, huella aprobada y tests intactos", async () => {
    const r = await run();
    assert.equal(r.sha, HEAD);
    assert.equal(r.base, BASE);
  });

  it("rechaza un commit que no es el HEAD de main (rama de IA o commit antiguo)", async () => {
    await assert.rejects(run({}, { requested: s("f") }), /no es el HEAD de main/);
  });

  const green = (sha) => [{ head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", conclusion: "success" }];
  const social = { filename: "src/lib/blog/social-copy-pending.json", status: "modified", changes: 2 };

  it("HEAD sin CI (commit automático de contenido de redes) se despliega con la CI del commit anterior", async () => {
    const compare = { [`${MID}...${HEAD}`]: { status: "ahead", files: [social] }, [`${BASE}...${HEAD}`]: { status: "ahead", files: [social] } };
    assert.equal((await run({ runs: green(MID), compare })).sha, HEAD);
    assert.equal((await run({ runs: green(MID), compare }, { requested: MID })).sha, HEAD);
  });

  it("HEAD sin CI con código cambiado después del último verde: no se despliega", async () => {
    const compare = { [`${MID}...${HEAD}`]: { status: "ahead", files: [social, { filename: "src/app/page.tsx", status: "modified", changes: 1 }] } };
    await assert.rejects(run({ runs: green(MID), compare }), /no ha terminado en verde/);
    await assert.rejects(run({ runs: green(MID), compare }, { requested: MID }), /no es el HEAD de main/);
  });

  it("un sha pedido que no tiene CI en verde no sirve de respaldo", async () => {
    const compare = { [`${MID}...${HEAD}`]: { status: "ahead", files: [social] } };
    await assert.rejects(run({ runs: [], compare }, { requested: MID }), /no es el HEAD de main/);
  });

  it("rechaza un sha que no es de 40 caracteres hexadecimales (sin inyección por el input)", async () => {
    await assert.rejects(run({}, { requested: "main; curl evil" }), /sha no válido/);
    await assert.rejects(run({}, { requested: HEAD.slice(0, 7) }), /sha no válido/);
  });

  it("rechaza sin CI verde de main por push sobre ese commit", async () => {
    await assert.rejects(run({ runs: [] }), /no ha terminado en verde/);
    await assert.rejects(run({ runs: [{ head_sha: HEAD, head_branch: "ia/x", event: "push", path: ".github/workflows/ci.yml", conclusion: "success" }] }), /no ha terminado en verde/);
    await assert.rejects(run({ runs: [{ head_sha: HEAD, head_branch: "main", event: "pull_request", path: ".github/workflows/ci.yml", conclusion: "success" }] }), /no ha terminado en verde/);
    await assert.rejects(run({ runs: [{ head_sha: HEAD, head_branch: "main", event: "push", path: ".github/workflows/otro.yml", conclusion: "success" }] }), /no ha terminado en verde/);
  });
});

describe("verify: ficheros protegidos", () => {
  for (const [what, file] of [
    ["un script de package.json", "package.json"],
    ["una dependencia (lockfile)", "pnpm-lock.yaml"],
    ["la configuración de Playwright", "playwright.config.ts"],
    ["el global-setup de E2E", "e2e/global-setup.ts"],
    ["un workflow", ".github/workflows/ci.yml"],
    ["una migración", "prisma/migrations/2026_x/migration.sql"],
  ]) {
    it(`para el despliegue si cambia ${what}`, async () => {
      const tree = TREE.map((e) => (e.path === file ? { ...e, sha: "cambiado" } : e));
      await assert.rejects(run({ tree }), /no están aprobados/);
    });
  }

  it("para el despliegue si se añade un fichero protegido nuevo (p. ej. vitest.config.ts)", async () => {
    await assert.rejects(run({ tree: [...TREE, { path: "vitest.config.ts", type: "blob", sha: "z" }] }), /no están aprobados/);
  });

  it("no le afecta cambiar código de la app ni specs E2E (los vigila la regla de tests)", async () => {
    const tree = TREE.map((e) => (e.path === "src/app/page.tsx" || e.path === "e2e/rsvp.spec.ts" ? { ...e, sha: "cambiado" } : e));
    assert.equal((await run({ tree })).sha, HEAD);
  });
});

describe("verify: tests debilitados desde el último despliegue", () => {
  const cmp = (files) => ({ [`${BASE}...${HEAD}`]: { status: "ahead", files } });

  it("para el despliegue si se borra un test", async () => {
    await assert.rejects(run({ compare: cmp([{ filename: "src/lib/x.test.ts", status: "removed", changes: 10 }]) }), /borra src\/lib\/x.test.ts/);
  });

  it("para el despliegue si se añade .skip u .only", async () => {
    const patch = "@@ -1 +1 @@\n-it('a', () => {})\n+it.skip('a', () => {})";
    await assert.rejects(run({ compare: cmp([{ filename: "src/lib/x.test.ts", status: "modified", patch, changes: 2 }]) }), /añade it.skip/);
  });

  it("acepta tests nuevos o ampliados", async () => {
    const patch = "@@ -1 +1,2 @@\n it('a', () => {})\n+it('b', () => {})";
    assert.equal((await run({ compare: cmp([{ filename: "src/lib/x.test.ts", status: "modified", patch, changes: 1 }]) })).sha, HEAD);
  });

  it("acepta el debilitamiento si el propietario aprobó ese commit o uno posterior al despliegue", async () => {
    const weak = { status: "ahead", files: [{ filename: "src/lib/x.test.ts", status: "removed", changes: 1 }] };
    const compare = { [`${BASE}...${MID}`]: weak, [`${MID}...${HEAD}`]: { status: "ahead", files: [] }, [`${BASE}...${HEAD}`]: weak };
    const r = await run({ compare }, { approvals: `huella ${FP} x\ncommit ${MID} 2026-11-04 test obsoleto` });
    assert.equal(r.base, MID);
  });

  it("rechaza si main no desciende del último despliegue (historial reescrito)", async () => {
    await assert.rejects(run({ compare: { [`${BASE}...${HEAD}`]: { status: "diverged", files: [] } } }), /no desciende/);
  });

  it("sin despliegue registrado usa base-inicial.txt", async () => {
    const r = await run({ deployed: null }, { bootstrap: s("d") });
    assert.equal(r.base, s("d"));
  });
});

describe("reglas", () => {
  it("SKIP_RE detecta las formas habituales y no los usos normales", () => {
    for (const l of ["it.skip('x'", "describe.only(", "test.fixme(", "test.skip(true)", "xit('x'", "it('x', { skip: true }, () =>", "t.todo("]) assert.match(l, SKIP_RE);
    for (const l of ["it('salta el paso', () =>", "const skipped = 1", "expect(r.skipReason).toBe('x')"]) assert.doesNotMatch(l, SKIP_RE);
  });

  it("testWeakenings no revisa a ciegas diffs enormes", () => {
    assert.match(testWeakenings(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: "modified" })))[0], /demasiados/);
    assert.match(testWeakenings([{ filename: "a.test.ts", status: "modified", changes: 5000 }])[0], /demasiado grande/);
  });

  it("parseApprovals ignora líneas mal formadas y comentarios", () => {
    const a = parseApprovals(`# huella ${"f".repeat(64)}\nhuella corto\ncommit ${HEAD} x\ncommit main x`);
    assert.equal(a.fingerprints.size, 0);
    assert.deepEqual(a.commits, [HEAD]);
  });

  it("protegido.txt: las specs E2E no son protegidas, el resto de e2e sí", () => {
    assert.equal(isProtected("e2e/a/b.spec.ts"), false);
    assert.equal(isProtected("e2e/rsvp.spec.ts"), false);
    assert.equal(isProtected(".github/workflows/ci.yml"), true);
    assert.equal(isProtected("prisma/migrations/x/migration.sql"), true);
    assert.equal(isProtected("e2e/helpers/mail.ts"), true);
    assert.equal(isProtected("tsconfig.json"), true);
    assert.equal(isProtected("src/app/page.tsx"), false);
  });

  it("la huella no depende del orden del árbol", () => {
    assert.equal(fingerprint([...TREE].reverse(), isProtected).fingerprint, FP);
  });

  it("los rechazos son Refused (mensaje claro, no un fallo inesperado)", async () => {
    await run({}, { requested: "x" }).catch((e) => assert.ok(e instanceof Refused));
  });
});

describe("verify: quién movió main desde el último despliegue", () => {
  const bot = { login: "github-actions[bot]", type: "Bot" };
  it("acepta pushes y fusiones de PR del propietario hasta la base", async () => {
    assert.equal((await run()).sha, HEAD);
  });
  it("rechaza un commit empujado a main por un workflow (github-actions[bot])", async () => {
    await assert.rejects(run({ activity: [upd(MID, HEAD, bot), ...ACTIVITY.slice(1)] }), /github-actions\[bot\], que no es el propietario/);
  });
  it("rechaza un push de otra cuenta aunque luego el propietario empuje encima", async () => {
    const other = { login: "Losabestu", type: "User" };
    await assert.rejects(run({ activity: [upd(MID, HEAD), upd(BASE, MID, other)] }), /Losabestu, que no es el propietario/);
  });
  it("rechaza un bot que se llame como el propietario", async () => {
    await assert.rejects(run({ activity: [upd(MID, HEAD, { login: "o", type: "Bot" }), ...ACTIVITY.slice(1)] }), /no es el propietario/);
  });
  it("rechaza un force-push del propietario", async () => {
    await assert.rejects(run({ activity: [upd(MID, HEAD, owner, "force_push"), ...ACTIVITY.slice(1)] }), /force_push de o: solo valen push o fusión/);
  });
  it("rechaza una actualización sin actor", async () => {
    await assert.rejects(run({ activity: [upd(MID, HEAD, null), ...ACTIVITY.slice(1)] }), /desconocido, que no es el propietario/);
  });
  it("rechaza si el registro no explica cómo llegó main al HEAD", async () => {
    await assert.rejects(run({ activity: [] }), /no dice quién llevó main/);
    await assert.rejects(run({ activity: [upd(MID, HEAD)] }), /no dice quién llevó main a ccccccc/);
  });
  it("la base aprobada corta la cadena: lo anterior a ella no se revisa", async () => {
    const compare = { [`${BASE}...${MID}`]: { status: "ahead", files: [] }, [`${MID}...${HEAD}`]: { status: "ahead", files: [] } };
    const r = await run({ compare, activity: [upd(MID, HEAD), upd(BASE, MID, bot)] }, { approvals: `huella ${FP} x\ncommit ${MID} 2026-11-04 revisado` });
    assert.equal(r.base, MID);
  });
  it("sin cambios desde el despliegue no consulta la actividad", async () => {
    const { api, calls } = fakeApi({ deployed: HEAD, activity: [] });
    await verify({ api, appRepo: "o/app", deployRepo: "o/deploy", requested: "", protectedText: PROTECTED, approvalsText: `huella ${FP} x`, bootstrapBase: s("e"), ciIgnoredText: SIN_CI, log: () => {} });
    assert.equal(calls.some((p) => p.includes("/activity")), false);
  });
});
