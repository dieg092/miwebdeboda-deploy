// Commit de wedding-invite-2 que está en producción (último despliegue con éxito de este repositorio, o la
// base inicial aprobada si aún no hay ninguno). Los workflows con secretos que ejecutan código de la app
// (health checks, monitor sintético) solo descargan ese commit: ya pasó la puerta y ya corre en producción
// con todos los secretos, así que ejecutarlo aquí no da a nadie un acceso que no tuviera.
//
// Entrada (env): DEPLOY_REPO, GH_TOKEN (el GITHUB_TOKEN del workflow, con deployments: read).
// Salida (GITHUB_OUTPUT): sha=…
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Refused, deployedOrBootstrap, github } from "./verify-deployable.mjs";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { DEPLOY_REPO, GH_TOKEN, GITHUB_OUTPUT } = process.env;
try {
  if (!DEPLOY_REPO || !GH_TOKEN) throw new Refused("faltan DEPLOY_REPO o GH_TOKEN");
  const bootstrap = readFileSync(path.join(here, "base-inicial.txt"), "utf8").replace(/#.*/g, "").trim();
  const sha = await deployedOrBootstrap(github(GH_TOKEN), DEPLOY_REPO, bootstrap);
  console.log(`Commit en producción: ${sha}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `sha=${sha}\n`);
} catch (e) {
  console.log(`::error::${e instanceof Refused ? e.message : `fallo inesperado: ${e?.message ?? e}`}`);
  process.exit(1);
}
