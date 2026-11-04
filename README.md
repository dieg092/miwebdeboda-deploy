# miwebdeboda-deploy

Despliegue a producción de miwebdeboda.com y comprobaciones que necesitan
credenciales reales. **Ninguna tarea de IA trabaja en este repositorio**: vive
fuera de las carpetas de Órbita y es el único sitio con secretos de producción
en GitHub.

## Por qué existe

En GitHub Free, los secretos de un repositorio privado los puede leer cualquier
workflow de cualquier rama: basta con que una rama cambie su `ci.yml`. Las ramas
`ia/**` de wedding-invite-2 las escribe la IA, así que ese repositorio ya no
guarda ningún secreto de producción:

| Dónde | Qué secretos | Quién escribe código |
|---|---|---|
| `wedding-invite-2` | ninguno de producción: `STRIPE_TEST_SECRET_KEY` (modo test) y `DEPLOY_DISPATCH_TOKEN` (solo lanza `deploy.yml`) | propietario + tareas de IA |
| `miwebdeboda-deploy` (este) | Vercel, AWS, Resend, BD de producción, Telegram | solo el propietario |
| `seo-agent` (público) | en el entorno `produccion`, que solo admite `main` | propietario + tareas de IA |

## Flujo

1. Se fusiona en `main` de wedding-invite-2 y su CI corre **sin secretos**
   (Postgres, S3, Upstash y Resend simulados).
2. Si termina en verde, su último paso lanza `deploy.yml` aquí con el sha.
3. `scripts/verify-deployable.sh` lo comprueba todo por su cuenta, con un token
   de solo lectura:
   - es el **HEAD actual de `main`** (nunca un commit antiguo ni de otra rama);
   - hay una ejecución de `ci.yml` **en `main`, por push, sobre ese sha**,
     terminada en éxito (una rama no puede crearla);
   - el `ci.yml` de ese commit está en `approved-ci.sha1` (si alguien debilita
     la CI en `main`, no se despliega hasta que el propietario la apruebe aquí).
4. Sube las imágenes del blog a S3, `vercel deploy --prod` (Vercel aplica la
   migración con sus variables de producción), smoke test y aviso por Telegram.

Un `DEPLOY_DISPATCH_TOKEN` filtrado solo puede volver a lanzar el despliegue del
HEAD de `main` ya validado.

## Workflows

- `deploy.yml`: despliegue (desde la CI de main o a mano en Actions, con el sha
  o vacío para el HEAD de main).
- `health-checks.yml`: canario de email, latido de crons y comprobaciones del
  blog contra producción (diario, 08:45 UTC). Antes estaba en wedding-invite-2.

Lighthouse sigue en wedding-invite-2, ya sin secretos (base efímera).

## Aprobar un cambio de la CI

Cuando un cambio de `.github/workflows/ci.yml` llegue a `main` el despliegue se
parará con «ci.yml no aprobado». Revisad el diff y, si es correcto:

```sh
cd wedding-invite-2 && git hash-object .github/workflows/ci.yml
# añadir ese hash a approved-ci.sha1 aquí, commit y push; después relanzar deploy.yml
```

## Recuperación

- **Volver a la versión anterior**: Vercel → proyecto → Deployments → el
  anterior → *Instant Rollback* (o `vercel rollback` en local). No reconstruye
  ni migra. Solo si la migración del último deploy es compatible hacia atrás;
  si no, arreglar hacia delante.
- **Relanzar un despliegue**: Actions → «Deploy a producción» → Run workflow.
- **Si GitHub Actions no está disponible**: `vercel deploy --prod` desde un
  checkout limpio de `main` en el portátil del propietario.
- **Rotar un secreto**: `gh secret set NOMBRE -R dieg092/miwebdeboda-deploy`.

## Puesta en marcha

`setup/configurar-secretos.sh`, que ejecuta el propietario. Lee los valores de
producción con `vercel env pull` y pide por teclado los tokens que hay que crear
a mano. Nunca escribe ningún valor en disco ni en pantalla.
