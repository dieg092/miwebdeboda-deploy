# Rotación de las credenciales antiguas

Hasta el cambio de arquitectura, cualquier rama `ia/**` de wedding-invite-2 (y
cualquier rama de seo-agent) podía leer los secretos de su repositorio con solo
cambiar un workflow. No hay indicios de que haya pasado, pero **hay que tratarlos
como expuestos**. Borrar un secreto de GitHub no lo invalida: hay que rotarlo en
el servicio.

**Cuándo:** después del cambio (primer despliegue correcto desde este repositorio y
`setup/retirar-secretos-antiguos.sh`). Antes no sirve: el valor nuevo volvería a
estar en los repositorios expuestos.

**Regla para no cortar el servicio:** primero crear la credencial nueva, ponerla
en Vercel (y aquí o en seo-agent si la usan), desplegar, comprobar, y **solo
entonces** revocar la antigua. Donde el servicio no admite dos credenciales a la
vez, se indica la ventana de corte.

Para cada cambio en Vercel: `vercel env rm NOMBRE production` + `vercel env add
NOMBRE production` (o el panel), y desplegar: Actions → «Deploy a producción» →
Run workflow (sin sha). Para GitHub: `gh secret set NOMBRE -R <repo>`.

## Orden y procedimiento

| # | Credencial | Dónde se usa ahora | Cómo rotar sin corte | Corte |
|---|---|---|---|---|
| 1 | `VERCEL_TOKEN` antiguo | ya no se usa (lo sustituye el nuevo de este repo) | Vercel → Account → Tokens → borrar el antiguo | ninguno |
| 2 | AWS (`AWS_ACCESS_KEY_ID`/`SECRET`) | Vercel (app), aquí (imágenes del blog) | IAM permite 2 claves por usuario: crear la 2ª → Vercel + aquí → desplegar → comprobar subida de una foto → **desactivar** la antigua → 48 h sin errores → borrarla | ninguno |
| 3 | Resend (`RESEND_API_KEY`) | Vercel, aquí (canario) | crear clave nueva (permiso «Sending», dominio miwebdeboda.com) → Vercel + aquí → desplegar → canario en verde → borrar la antigua | ninguno |
| 4 | Upstash (`UPSTASH_REDIS_REST_TOKEN`) | Vercel (rate limit) | consola Upstash → «Reset token» invalida el antiguo al instante: hacerlo y actualizar Vercel en el mismo minuto, desplegar | 1–3 min sin rate limit (la app debe degradar abierta; comprobadlo antes en preview) |
| 5 | Cloudflare Workers AI (4 tokens + ids) | Vercel/scripts locales, seo-agent | crear token nuevo en cada cuenta (permiso Workers AI) → poner → revocar el antiguo. Los `ACCOUNT_ID` no son secretos, no se rotan | ninguno |
| 6 | Proxies (`PROXY_*`) | scripts de colaboraciones | cambiar la contraseña en el panel del proveedor y en el `.env` local de quien los use | ninguno (no corre en producción) |
| 7 | Telegram (`TELEGRAM_BOT_TOKEN`) | aquí, seo-agent | BotFather → /revoke da token nuevo e invalida el anterior al momento: actualizar aquí y en el entorno `produccion` de seo-agent a la vez | solo avisos, unos minutos |
| 8 | `CRON_SECRET`, `SYNTHETIC_MONITOR_SECRET` | Vercel (crons y monitor) | generar (`openssl rand -hex 32`) → Vercel y aquí → desplegar. Vercel manda el nuevo a los crons tras el deploy | el cron que caiga entre el cambio y el deploy puede dar 401: hacerlo justo después de una ejecución |
| 9 | `EMAIL_VERIFICATION_SECRET`, `PASSWORD_RESET_SECRET` | Vercel | generar → Vercel → desplegar | los enlaces de verificación y de contraseña enviados antes dejan de valer (caducan en horas de todos modos): hacerlo de madrugada |
| 10 | `JWT_SECRET` / `PROD_JWT_SECRET` | Vercel | generar → Vercel → desplegar | **cierra todas las sesiones** (duran 7 días). Para evitarlo hay que aceptar antes dos secretos (`JWT_SECRET` + `JWT_SECRET_PREVIOUS` durante 7 días): cambio pequeño en `createSessionUser`/`getSessionUser`, tarea aparte |
| 11 | Base de datos (`DATABASE_URL`, `DIRECT_URL`, `PROD_*`) | Vercel, aquí (health checks) | Neon → Roles → el rol de la app → «Reset password» invalida la antigua: tener preparadas las 4 URLs nuevas, cambiar Vercel y aquí en el mismo momento y desplegar. Las conexiones ya abiertas siguen; las nuevas fallan hasta el deploy | 2–4 min de errores en peticiones que abran conexión nueva: hacerlo de madrugada |
| 12 | seo-agent (`DATABASE_URL`/`DIRECT_URL` de su BD) | entorno `produccion` | igual que el 11 en su proyecto de Neon; actualizar el entorno y el `.env` local | el workflow que coincida falla y se reintenta al día siguiente |
| 13 | Google (`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`) | seo-agent | Google Cloud → cuenta de servicio → Keys → crear clave nueva → entorno `produccion` → ejecutar un workflow → borrar la clave antigua | ninguno |
| 14 | `PAGESPEED_API_KEY`, `HEALTHCHECKS_PING_URL`, `SEO_PRIVATE_URL_KEY` | seo-agent | crear nueva (clave de API / check nuevo / `openssl rand`) → entorno → borrar la antigua | ninguno |
| 15 | `WEDDING_INVITE_2_PAT` | seo-agent | **tiene escritura en el código de wedding-invite-2** (puede empujar a main). Sustituirlo por uno con el mínimo que necesite seo-agent; si solo abre PRs, sigue necesitando Contents: write, así que revocarlo en cuanto seo-agent deje de abrir PRs (tarea B10 de su spec) | ninguno |
| 16 | `STRIPE_TEST_SECRET_KEY` | wedding-invite-2 (tests) | modo test, no da acceso a dinero real: Stripe → Developers → API keys (test) → «Roll key» con caducidad del antiguo en 24 h | ninguno |
| 17 | Repos sin workflows (colaboraciones-worker, instagram-carousels, pinterest-publisher) | `.env` locales | sus secretos de GitHub ya están borrados. Si alguna rama de IA tuvo workflows en ellos, rotar sus claves (Apify, Anthropic, Google Search, SerpAPI, Tavily, Groq, Pinterest, Facebook) igual: crear → `.env` → revocar | ninguno |

Los valores no se escriben nunca en el chat, en tareas de Órbita ni en ficheros
del repositorio: solo en Vercel, en `gh secret set` o en los `.env` locales.

## Comprobación después de cada bloque

- Despliegue: el workflow termina en ✅ y el smoke test en verde.
- Correo: health-checks.yml (Actions → Run workflow) con el canario en verde.
- Base de datos: entrar en la web con una cuenta de prueba.
- Si algo falla: volver a poner el valor anterior **solo si aún no se ha
  revocado** (por eso se revoca al final) y relanzar el despliegue.
