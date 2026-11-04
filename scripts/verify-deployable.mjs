#!/usr/bin/env node
// Única puerta al despliegue de wedding-invite-2. Vive aquí, fuera del repositorio que
// escriben las tareas de IA, para que ninguna rama pueda cambiarla ni saltársela.
//
// Se despliega un commit solo si:
//   1. es el HEAD actual de main (nunca uno antiguo ni de otra rama);
//   2. la CI de main (ci.yml, por push) terminó en verde sobre ese commit, o sobre uno
//      anterior de main seguido solo de ficheros que la CI no prueba (sin-ci.txt);
//   3. la huella de los ficheros que deciden qué se prueba y cómo se despliega
//      (protegido.txt: workflows, package.json, lockfile, configs de tests, scripts
//      de la CI, migraciones…) está aprobada por el propietario en aprobaciones.txt;
//   4. desde el último despliegue no se ha borrado ningún test ni se ha añadido un
//      .skip/.only/.todo/fixme, salvo que el propietario apruebe ese commit.
//
// Solo lee: GitHub (con un token de solo lectura) y los ficheros de este repositorio.
// La única entrada que acepta de fuera es el sha, que tiene que ser el HEAD de main.
//
// Entorno: APP_REPO, DEPLOY_REPO, GH_TOKEN, REQUESTED (sha o vacío).
// Salida (GITHUB_OUTPUT): sha=…, fingerprint=…, base=…
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA_RE = /^[0-9a-f]{40}$/;

export class Refused extends Error {}
const refuse = (msg) => {
  throw new Refused(msg);
};

// ---------- reglas (puras, con tests) ----------

/** Globs de protegido.txt («**», «*», y líneas «!glob» que excluyen) → función path → bool. */
export function protectedMatcher(text) {
  const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // «**/» = cero o más carpetas, «**» = cualquier cosa, «*» = dentro de una carpeta
  const toRe = (g) =>
    new RegExp(
      "^" +
        g
          .split("**/")
          .map((a) => a.split("**").map((b) => b.split("*").map(esc).join("[^/]*")).join(".*"))
          .join("(?:.*/)?") +
        "$",
    );
  const rules = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("!") ? { neg: true, re: toRe(l.slice(1)) } : { neg: false, re: toRe(l) }));
  return (p) => {
    let hit = false;
    for (const r of rules) if (r.re.test(p)) hit = !r.neg;
    return hit;
  };
}

/** Huella de los ficheros protegidos de un árbol de git: sha256 de «ruta blob» ordenado. */
export function fingerprint(treeEntries, isProtected) {
  const lines = treeEntries
    .filter((e) => e.type === "blob" && isProtected(e.path))
    .map((e) => `${e.path} ${e.sha}`)
    .sort();
  return { fingerprint: createHash("sha256").update(lines.join("\n")).digest("hex"), files: lines.length };
}

/** aprobaciones.txt: «huella <sha256> …» y «commit <sha> …»; # comenta. */
export function parseApprovals(text) {
  const out = { fingerprints: new Set(), commits: [] };
  for (const raw of text.split("\n")) {
    const [kind, value] = raw.replace(/#.*/, "").trim().split(/\s+/);
    if (kind === "huella" && /^[0-9a-f]{64}$/.test(value ?? "")) out.fingerprints.add(value);
    if (kind === "commit" && SHA_RE.test(value ?? "")) out.commits.push(value);
  }
  return out;
}

export const isTestFile = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
// .skip/.only/.todo/.fixme de node:test, Vitest y Playwright; xit/xdescribe; { skip: …} / { todo: … }
export const SKIP_RE = /\.(skip|only|todo|fixme)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|[{,]\s*(skip|todo|only)\s*:/;
export const MAX_COMPARE_FILES = 300; // la API de comparación no da más

/** Debilitamientos de los tests entre dos commits (ficheros de /compare). */
export function testWeakenings(files) {
  if (files.length >= MAX_COMPARE_FILES) return [`el cambio toca ${files.length} ficheros o más: demasiados para revisarlo automáticamente`];
  const out = [];
  for (const f of files) {
    if (f.status === "removed" && isTestFile(f.filename)) out.push(`borra ${f.filename}`);
    if (f.status === "renamed" && isTestFile(f.previous_filename ?? "") && !isTestFile(f.filename)) out.push(`${f.previous_filename} deja de ser un test`);
    if (!isTestFile(f.filename) || f.status === "removed") continue;
    if (f.patch === undefined) {
      if (f.changes > 0) out.push(`${f.filename}: el diff es demasiado grande para revisarlo automáticamente`);
      continue;
    }
    const added = f.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const hits = added.filter((l) => SKIP_RE.test(l));
    if (hits.length) out.push(`${f.filename}: añade ${hits.map((l) => l.slice(1).trim().slice(0, 80)).join(" · ")}`);
  }
  return out;
}

// ---------- GitHub ----------

export function github(token, fetchImpl = fetch) {
  return async (p) => {
    const res = await fetchImpl(`https://api.github.com/${p}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) refuse(`GitHub respondió ${res.status} a ${p.split("?")[0]}`);
    return res.json();
  };
}

/** /compare con todas sus páginas de ficheros (100 por página, hasta el límite de 300 de la API). */
async function compareAll(api, repo, base, head) {
  const first = await api(`repos/${repo}/compare/${base}...${head}?per_page=100&page=1`);
  const files = [...(first.files ?? [])];
  for (let page = 2; files.length === (page - 1) * 100 && page <= MAX_COMPARE_FILES / 100; page++) {
    const next = await api(`repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`);
    files.push(...(next.files ?? []));
  }
  return { status: first.status, files };
}

/** Último commit de la app desplegado con éxito por este repositorio (registro de deployments). */
async function lastDeployed(api, deployRepo) {
  const deployments = await api(`repos/${deployRepo}/deployments?environment=produccion&per_page=30`);
  for (const d of deployments) {
    const statuses = await api(`repos/${deployRepo}/deployments/${d.id}/statuses?per_page=10`);
    const appSha = d.payload?.app_sha;
    if (statuses.some((s) => s.state === "success") && SHA_RE.test(appSha ?? "")) return appSha;
  }
  return null;
}

export async function verify({ api, appRepo, deployRepo, requested, protectedText, approvalsText, bootstrapBase, ciIgnoredText = "", log = console.log }) {
  const head = (await api(`repos/${appRepo}/commits/main`)).sha;
  if (requested && !SHA_RE.test(requested)) refuse(`sha no válido: '${requested}' (hace falta el sha completo de 40 caracteres)`);
  // Siempre se despliega el HEAD de main. «requested» (el commit cuya CI lanzó el despliegue) solo sirve para
  // saber qué CI en verde lo respalda.
  const sha = head;
  const isGreen = (r, c) => r.head_sha === c && r.head_branch === "main" && r.event === "push" && r.path === ".github/workflows/ci.yml" && r.conclusion === "success";
  const greenRuns = await api(`repos/${appRepo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=30`);
  const greenShas = [...new Set(greenRuns.workflow_runs.filter((r) => isGreen(r, r.head_sha)).map((r) => r.head_sha))];
  let ciSha = greenShas.includes(head) ? head : null;
  if (!ciSha) {
    // HEAD sin CI: vale la CI en verde de un commit anterior de main si todo lo que hay después son ficheros que la
    // CI no prueba (sin-ci.txt, copia de paths-ignore de ci.yml: contenido de redes, docs…).
    const candidates = requested ? [requested] : greenShas;
    const ignored = protectedMatcher(ciIgnoredText);
    for (const g of candidates) {
      if (!greenShas.includes(g)) continue;
      const c = await compareAll(api, appRepo, g, head);
      if (c.status === "ahead" && c.files.length < MAX_COMPARE_FILES && c.files.every((f) => ignored(f.filename) && (!f.previous_filename || ignored(f.previous_filename)))) {
        ciSha = g;
        break;
      }
    }
  }
  if (requested && requested !== head && ciSha !== requested) {
    refuse(`${requested} no es el HEAD de main (${head}) y lo que hay después no son solo ficheros sin CI. Solo se despliega el último commit de main; para volver atrás, rollback de Vercel (README).`);
  }
  if (!ciSha) refuse(`la CI de main no ha terminado en verde sobre ${head} (ni sobre un commit anterior seguido solo de ficheros sin CI): no se despliega`);

  const tree = await api(`repos/${appRepo}/git/trees/${sha}?recursive=1`);
  if (tree.truncated) refuse("el árbol del repositorio es demasiado grande para calcular la huella");
  const isProtected = protectedMatcher(protectedText);
  const fp = fingerprint(tree.tree, isProtected);
  const approvals = parseApprovals(approvalsText);
  if (!approvals.fingerprints.has(fp.fingerprint)) {
    refuse(
      `los ficheros protegidos de ${sha} (${fp.files}: workflows, package.json, lockfile, configuración de tests, migraciones…) no están aprobados ` +
        `(huella ${fp.fingerprint}). Revisad el diff y, si es correcto: bash scripts/aprobar.sh huella ${sha}`,
    );
  }

  // Base para buscar tests debilitados: el último despliegue, o un commit posterior que el propietario aprobó.
  let base = (await lastDeployed(api, deployRepo)) ?? bootstrapBase;
  if (!SHA_RE.test(base ?? "")) refuse("no hay despliegue anterior registrado ni base-inicial.txt: no se puede comprobar qué tests han cambiado");
  for (const c of approvals.commits) {
    if (c === base) continue;
    const fromBase = await api(`repos/${appRepo}/compare/${base}...${c}`);
    const toSha = c === sha ? { status: "identical" } : await api(`repos/${appRepo}/compare/${c}...${sha}`);
    if (fromBase.status === "ahead" && (toSha.status === "ahead" || toSha.status === "identical")) base = c;
  }
  const cmp = base === sha ? { status: "identical", files: [] } : await compareAll(api, appRepo, base, sha);
  if (cmp.status !== "ahead" && cmp.status !== "identical") {
    refuse(`${sha} no desciende de ${base} (estado ${cmp.status}): historial reescrito. Si es correcto: bash scripts/aprobar.sh commit ${sha}`);
  }
  const weak = testWeakenings(cmp.files ?? []);
  if (weak.length) refuse(`desde ${base.slice(0, 7)} se debilitan los tests:\n  - ${weak.join("\n  - ")}\nSi es correcto: bash scripts/aprobar.sh commit ${sha}`);

  log(`Desplegable: ${sha} (HEAD de main, CI en verde${ciSha === sha ? "" : ` en ${ciSha.slice(0, 7)} + solo ficheros sin CI`}, ${fp.files} ficheros protegidos aprobados, tests sin debilitar desde ${base.slice(0, 7)})`);
  return { sha, fingerprint: fp.fingerprint, base };
}

// ---------- CLI ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { APP_REPO, DEPLOY_REPO, GH_TOKEN, REQUESTED = "", GITHUB_OUTPUT } = process.env;
  try {
    if (!APP_REPO || !DEPLOY_REPO) refuse("faltan APP_REPO o DEPLOY_REPO");
    if (!GH_TOKEN) refuse("falta APP_READ_TOKEN");
    const read = (f) => readFileSync(path.join(here, f), "utf8");
    const r = await verify({
      api: github(GH_TOKEN),
      appRepo: APP_REPO,
      deployRepo: DEPLOY_REPO,
      requested: REQUESTED.trim(),
      protectedText: read("protegido.txt"),
      approvalsText: read("aprobaciones.txt"),
      bootstrapBase: read("base-inicial.txt").replace(/#.*/g, "").trim(),
      ciIgnoredText: read("sin-ci.txt"),
    });
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `sha=${r.sha}\nfingerprint=${r.fingerprint}\nbase=${r.base}\n`);
  } catch (e) {
    console.log(`::error::${e instanceof Refused ? e.message.replace(/\n/g, "%0A") : `fallo inesperado: ${e?.message ?? e}`}`);
    process.exit(1);
  }
}
