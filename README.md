# miwebdeboda-deploy

Despliegue a producción de miwebdeboda.com y comprobaciones que necesitan
credenciales reales. **Ninguna tarea de IA trabaja en este repositorio**: vive
fuera de las carpetas de Órbita (y el sandbox de los agentes no puede leerlo) y es
el único sitio con secretos de producción de la web en GitHub.

## Por qué existe

En GitHub Free, los secretos de un repositorio privado los puede leer cualquier
workflow de cualquier rama. Las ramas `ia/**` de wedding-invite-2 las escribe la
IA, así que ese repositorio ya no guarda ningún secreto de producción:

| Dónde | Qué secretos | Quién escribe código |
|---|---|---|
| `wedding-invite-2` | ninguno de producción: `STRIPE_TEST_SECRET_KEY` (modo test) y `DEPLOY_DISPATCH_TOKEN` (solo lanza `deploy.yml`) | propietario + tareas de IA |
| `miwebdeboda-deploy` (este) | Vercel, AWS, Resend, BD de producción, Telegram, lectura de la app | solo el propietario |
| `seo-agent` (público) | en el entorno `produccion`, que solo admite `main`; la IA no fusiona en su main (`.orbita/ai-task.json`) | propietario + ramas de IA |

## Flujo

1. Algo llega a `main` de wedding-invite-2 (siempre una fusión del propietario:
   Órbita solo prepara PR, `.orbita/ai-task.json` `"autoMerge": false`) y la CI corre **sin secretos**
   (Postgres, S3, Upstash, Resend y Workers AI simulados).
2. Si termina en verde, su último paso lanza `deploy.yml` aquí.
3. `scripts/verify-deployable.mjs` lo comprueba todo con un token de solo lectura:
   - se despliega **siempre el HEAD de `main`**;
   - con su CI de `main` en verde (o la de un commit anterior de main si lo que
     hay después son solo ficheros que la CI no prueba, `sin-ci.txt`: los commits
     automáticos de contenido de redes);
   - con la **huella de los ficheros protegidos** (`protegido.txt`: workflows,
     `package.json`, lockfile, configuración de TypeScript/ESLint/Playwright/Vitest,
     preparación de E2E, scripts de la CI, migraciones, `vercel.json`,
     `next.config.ts`) aprobada en `aprobaciones.txt`;
   - sin tests borrados ni `.skip`/`.only`/`.todo`/`fixme` nuevos desde el último
     despliegue, salvo commit aprobado.
4. Jobs separados, cada uno en una máquina nueva:
   - `assets` ejecuta código de la app (variantes de imagen) **sin secretos**;
   - `deploy` tiene los secretos pero solo ejecuta código de este repositorio y
     herramientas fijadas en su `package-lock.json` (Vercel CLI, AWS SDK, instaladas
     con `--ignore-scripts`): de la app solo lee ficheros;
   - `smoke` ejecuta el smoke test de la app **sin secretos**;
   - `record` registra el despliegue (base para comprobar los tests la próxima vez).

Lo que no se puede hacer desde fuera: el único dato que entra es el sha y solo
como variable de entorno; todos los jobs exigen la versión de `main` de este
workflow; el token de despacho no puede leer ni escribir código, secretos, ramas,
ajustes ni registros de despliegue (lo comprueba `setup/comprobar-tokens.sh`), pero sí
cancelar o relanzar ejecuciones: ver «Riesgos que quedan» en `MIGRACION.md`.

## Aprobar

```sh
bash scripts/aprobar.sh huella <sha>   # cambios en ficheros protegidos (CI, dependencias, migraciones…)
bash scripts/aprobar.sh commit <sha>   # tests borrados o desactivados a propósito
```

El script enseña los ficheros que cambian, pide «si», añade la línea a
`aprobaciones.txt` y hace push. Después: Actions → «Deploy a producción» → Run
workflow. Una migración nueva (`prisma/migrations/**`) siempre necesita esta
aprobación: es la versión de `migracion-aprobada` que nadie más puede poner.

## Workflows

- `deploy.yml`: despliegue (desde la CI de main o a mano).
- `health-checks.yml`: canario de email, latido de crons y blog contra producción
  (diario, 09:15 UTC). **Desactivado** hasta que `setup/configurar-secretos.sh`
  ponga sus secretos (lo reactiva al terminar); el de wedding-invite-2 sigue hasta
  la fase 6 de `MIGRACION.md`.
- `monitor-sintetico.yml` (diario) y `stripe-live.yml` (lunes y jueves): monitor de
  suscripciones con Stripe, traídos de `miwebdeboda-synthetic-monitor`.
  **Desactivados** hasta `setup/cambiar-monitor.sh`.

Los tres ejecutan código de la app con secretos de producción, así que solo
descargan el commit que ya está en producción (`scripts/ultimo-desplegado.mjs`),
nunca el HEAD de main.
- `test.yml`: tests de la puerta (`npm test`), sin secretos.

## Recuperación

- **Volver a la versión anterior**: Vercel → Deployments → el anterior → *Instant
  Rollback* (o `vercel rollback`). No reconstruye ni migra: solo si la migración
  del último deploy es compatible hacia atrás; si no, arreglar hacia delante.
- **Relanzar un despliegue**: Actions → «Deploy a producción» → Run workflow.
- **Si GitHub Actions no está disponible**: `vercel deploy --prod` desde un
  checkout limpio de `main` en el portátil del propietario.
- **Si la puerta bloquea algo urgente y correcto**: aprobarlo (arriba), no
  desactivarla.
- **Rotar un secreto**: `ROTACION.md`.

## Puesta en marcha y pruebas

`MIGRACION.md`: fases en orden, con su comprobación y su vuelta atrás, la guía para
crear los tokens y los riesgos que quedan.

`npm test` cubre la puerta con una API de GitHub simulada.
