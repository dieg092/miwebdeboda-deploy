# Migración a despliegue aislado

Orden de activación. **Cada fase se comprueba antes de empezar la siguiente** y
tiene su vuelta atrás. Hasta la fase 7, los secretos antiguos siguen puestos: el
camino antiguo se puede recuperar en minutos revirtiendo un commit.

Quién: **P** = propietario (fusiones, aprobaciones, tokens, todo lo que toca
producción); **C** = Claude, solo cuando el propietario lo autoriza en esa fase.

## Fase 0 — Órbita sin fusión automática (hecha, 2026-11-04)

- Qué: `COPY_WORKER_AUTOMERGE_ACTIVITIES=` vacío en `~/Projects/personal/orbita/.env.worker`
  (el valor anterior queda comentado encima) y worker reiniciado. Las tareas siguen
  desarrollando, probando y subiendo su rama; ninguna toca main de ningún repo.
- Comprobar: `grep AUTOMERGE ~/Projects/personal/orbita/.env.worker`; la próxima
  tarea acaba en «rama … subida a origin», nunca en «fusionada en main».
- Volver atrás: descomentar la línea y `launchctl kickstart -k gui/$(id -u)/com.orbita.worker`.

## Fase 1 — El monitor sintético vuelve a funcionar (P)

Desde el 2026-10-04 el monitor falla cada día (el banner de cookies tapa los
botones de los planes) y por eso el health check antiguo está en rojo cada día
(«synthetic-monitor: último latido hace 742 h»). Sin arreglarlo no hay forma de
saber si los health checks nuevos funcionan.

- Qué: fusionar `ia/monitor-sintetico-cookies` en main de wedding-invite-2 (solo
  cambia `e2e/synthetic/*.spec.ts`). **Ojo:** hoy main todavía despliega con la CI
  antigua, así que esta fusión despliega (el mismo código de la app + el spec).
- Comprobar: Actions de `miwebdeboda-synthetic-monitor` → «Synthetic Stripe
  Subscription Monitor» → Run workflow → verde. Después, Actions de wedding-invite-2
  → «daily-health-checks» → Run workflow → verde.
- Volver atrás: revertir el commit (no cambia nada de la app).

## Fase 2 — Tokens y secretos (P)

- Qué: crear los tokens (guía abajo) y, en tu terminal (no a través de Claude):
  `bash ~/Projects/infra/miwebdeboda-deploy/setup/configurar-secretos.sh`.
  Comprueba cada token antes de guardarlo y activa `health-checks.yml` aquí (09:15 UTC;
  el antiguo de wedding-invite-2 sigue a las 08:45).
- Comprobar: el script termina en «Hecho» sin ✗; Actions de este repo → «Daily
  Health Checks» → Run workflow → verde (corre el commit de `base-inicial.txt`
  hasta el primer despliegue).
- Volver atrás: no hay nada que deshacer en producción. `gh workflow disable
  health-checks.yml -R dieg092/miwebdeboda-deploy` si molesta.

## Fase 3 — Rama de seguridad + primer despliegue desde aquí (P)

Requisito: fase 2 hecha (sin `DEPLOY_DISPATCH_TOKEN` la CI de main se pone en rojo).

- Qué:
  1. Fusionar `ia/seguridad-ci-sin-secretos` en main de wedding-invite-2 (y
     después, o en el mismo momento, `ia/seguridad-jwt-dos-claves`: sin
     `JWT_SECRET_PREVIOUS` se comporta exactamente igual que hoy).
  2. La CI de main corre sin secretos y pide el despliegue; `deploy.yml` lo **para**
     porque cambian ficheros protegidos (lo esperado).
  3. `bash scripts/aprobar.sh huella <sha de main>` (revisa la lista que enseña) →
     Actions → «Deploy a producción» → Run workflow.
- Comprobar: el run termina ✅ (verify, deploy, smoke); la web responde; aparece un
  registro en Deployments de este repo; Telegram avisa.
- Volver atrás: Vercel → Instant Rollback al deployment anterior (no hay
  migraciones de BD en estas ramas) y revertir la fusión en wedding-invite-2: la CI
  antigua vuelve a desplegar con los secretos antiguos, que siguen puestos.

## Fase 4 — Prueba de extremo a extremo (P)

- Qué: `bash setup/prueba-e2e.sh` (rama de IA → CI → intentos de saltarse la puerta
  → fusión → parada sin aprobación → aprobación → despliegue → limpieza).
- Comprobar: termina en «Prueba completa» con todos los pasos ✓.
- Volver atrás: el propio script limpia; si se corta a medias, revertir sus dos
  commits en main (`public/deploy-probe.txt` y el comentario de `.vercelignore`).

## Fase 5 — Órbita y seo-agent con sus ramas de seguridad (P, C con permiso)

- Qué:
  1. Órbita: fusionar `seguridad/sandbox-agentes`, `git pull` y `pnpm install` en
     `~/Projects/personal/orbita`, volver a poner
     `COPY_WORKER_AUTOMERGE_ACTIVITIES=8b0aa9b6-…` y reiniciar el worker. Desde aquí
     cada tarea corre en el sandbox y, en wedding-invite-2 y seo-agent
     (`"autoMerge": false`), pasa CI y revisión y **acaba en un PR**, nunca en main.
  2. seo-agent: fusionar `seguridad/entorno-produccion`.
- Comprobar: `pnpm tsx scripts/sandbox-probe.ts` en Órbita (herramientas solo
  Bash/Edit/Glob/Grep/Read/Write, MCP vacío, credenciales bloqueadas); una tarea
  pequeña de prueba en wedding-invite-2 abre un PR; un workflow de seo-agent en
  verde con el entorno `produccion`.
- Volver atrás: Órbita `git checkout 5e6f7cf` + reiniciar (y dejar AUTOMERGE vacío);
  seo-agent revertir la fusión (sus secretos de repositorio siguen hasta la fase 7).

## Fase 6 — Health checks y monitor: de lo antiguo a lo nuevo (P, C con permiso)

Nunca se apaga lo antiguo antes de ver lo nuevo en verde.

- Qué:
  1. Health checks: con `health-checks.yml` de aquí en verde al menos un día
     (programado, no solo a mano), PR que quita `daily-health-checks.yml` de
     wedding-invite-2 → fusionar.
  2. Monitor: `bash setup/cambiar-monitor.sh` (necesita un despliegue de la fase 3
     o posterior, que ya incluye el arreglo de la fase 1). Prueba el nuevo con un
     dispatch y solo si sale verde apaga los antiguos y activa los nuevos.
- Comprobar: al día siguiente, «Daily Health Checks» y «Monitor sintético» de este
  repo en verde y ninguno en los repos antiguos.
- Volver atrás: `bash setup/cambiar-monitor.sh --volver`; revertir el PR del
  health check antiguo (funciona mientras sus secretos sigan, hasta la fase 7).

## Fase 7 — Retirar los secretos antiguos (P)

- Qué: `bash setup/retirar-secretos-antiguos.sh`. Se niega a borrar nada si no hay
  un despliegue registrado, si `health-checks.yml` no está en verde, si
  `daily-health-checks.yml` sigue en main o si seo-agent no tiene un workflow en verde.
  Después, los secretos del repo antiguo del monitor (ROTACION.md, fila 18).
- Comprobar: `gh secret list -R dieg092/wedding-invite-2` → solo
  `STRIPE_TEST_SECRET_KEY` y `DEPLOY_DISPATCH_TOKEN`.
- Volver atrás: los valores siguen en Vercel (aún no rotados): se pueden volver a
  poner con `gh secret set`, pero no hace falta para nada de lo nuevo.

## Fase 8 — Rotación (P)

`ROTACION.md`, en su orden. `JWT_SECRET` con dos claves (sin cerrar sesiones).

## Fase 9 — Fusiones SEO (P)

F2 → F1 → C1 → C3 → C2, cada una por PR y, si toca ficheros protegidos o
migraciones, con `scripts/aprobar.sh`. C4 y C5 siguen en propuesta.

---

## Guía: los tres tokens

No pegues nunca un token en el chat ni en una tarea: solo en el script, que los lee
sin eco y los comprueba antes de guardarlos.

**a) APP_READ_TOKEN** — <https://github.com/settings/personal-access-tokens/new>
- Token name: `miwebdeboda-deploy lectura app` · Expiration: 90 days
- Resource owner: dieg092 · Repository access: **Only select repositories** →
  `wedding-invite-2`
- Repository permissions: **Contents: Read-only**, **Actions: Read-only**
  (Metadata: Read-only aparece sola). Nada más → Generate token → copiar.

**b) DEPLOY_DISPATCH_TOKEN** — mismo sitio, token nuevo
- Token name: `wedding-invite-2 lanza despliegue` · Expiration: 90 days
- Only select repositories → `miwebdeboda-deploy`
- Repository permissions: **Actions: Read and write**. Nada más.

**c) VERCEL_TOKEN** — <https://vercel.com/account/settings/tokens> → Create
- Name: `miwebdeboda-deploy` · Scope: el equipo del proyecto de miwebdeboda (no
  «Full Account» si deja elegir) · Expiration: 90 days.

Después: `bash ~/Projects/infra/miwebdeboda-deploy/setup/configurar-secretos.sh` en
tu terminal. Pide los tres tokens, Telegram (Enter para omitir), y para el monitor:
`LIVE_CANARY_EMAIL`, una `STRIPE_LIVE_RESTRICTED_KEY` nueva (Stripe → Developers →
API keys → Create restricted key, mismos permisos que la actual) y, si quieres, los
proxies. Lo que está en Vercel o en tu `.env` lo coge solo.

## Riesgos que quedan

- **DEPLOY_DISPATCH_TOKEN** (GitHub no permite menos): Actions: write en
  miwebdeboda-deploy, y lo puede leer cualquier rama de wedding-invite-2 (también
  las de IA). Con él se puede lanzar `deploy.yml` (solo despliega el HEAD de main
  ya validado y aprobado), **cancelar** despliegues, **relanzar** ejecuciones
  antiguas, **desactivar** workflows y **borrar logs**. No puede leer código ni
  secretos, ni cambiar código, ramas, ajustes o el registro de despliegues
  (comprobado por `setup/comprobar-tokens.sh`). Mitigaciones aplicadas: solo ese
  repositorio, caducidad de 90 días; un relanzamiento con una versión antigua de la
  puerta se rechaza (`runningSha` en `verify-deployable.mjs`); una ejecución
  cancelada avisa por Telegram; si el token falla, la CI de main se pone en rojo.
  Sin mitigar: desactivar `deploy.yml` o `health-checks.yml` (se notaría por la
  falta de avisos diarios) y borrar logs. Alternativa sin token: que este repo
  consulte cada 10 min si hay CI verde nueva en main (≈ 4.000 min/mes de Actions,
  más que el plan gratuito, y hasta 10–20 min de espera por despliegue).
- **GitHub Free**: sin protección de ramas ni entornos en repos privados. La
  garantía de que solo llega a main lo que el propietario fusiona es que nadie más
  tiene escritura: Órbita (fase 0/5) y `WEDDING_INVITE_2_PAT` de seo-agent
  (Contents: write en wedding-invite-2, ROTACION.md fila 15).
- **Código desplegado con secretos**: health checks y monitor ejecutan con la BD de
  producción el commit de la app que ya está en producción (ha pasado la puerta;
  Vercel lo ejecuta igualmente con todos los secretos). Un cambio malicioso que el
  propietario fusione y apruebe tiene los mismos efectos que en la propia web.
- **Ficheros no protegidos**: el código de la app fuera de `protegido.txt` se
  despliega con CI verde y fusión del propietario, sin aprobación aparte. La
  revisión del PR es el control.
- **El portátil del propietario**: tiene todas las credenciales; el sandbox de
  Órbita lo aísla de los agentes, no de un compromiso del propio portátil.
