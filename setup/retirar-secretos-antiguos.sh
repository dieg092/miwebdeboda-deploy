#!/usr/bin/env bash
# Último paso del cambio: borra de wedding-invite-2 todos los secretos salvo los
# dos que no son de producción, y de seo-agent los secretos de repositorio (sus
# workflows ya los leen del entorno «produccion»). Ejecutar solo después de:
#   - un despliegue correcto desde miwebdeboda-deploy, y
#   - una ejecución correcta de un workflow de seo-agent con environment: produccion.
set -euo pipefail
KEEP_WEB="STRIPE_TEST_SECRET_KEY DEPLOY_DISPATCH_TOKEN"
DEPLOY=dieg092/miwebdeboda-deploy
WEB=dieg092/wedding-invite-2

# Sin vuelta atrás fácil: antes de borrar, comprobar que lo nuevo ya hace el trabajo
# de lo antiguo (MIGRACION.md, fase 7). Cualquier fallo para el script sin tocar nada.
pre() { echo "  ✗ $1"; echo "No se ha borrado nada."; exit 1; }
echo "Comprobaciones previas:"
[ -n "$(gh api "repos/$DEPLOY/deployments?environment=produccion&per_page=1" --jq '.[0].id // empty')" ] \
  || pre "aún no hay ningún despliegue registrado desde $DEPLOY"
[ "$(gh run list -R $DEPLOY -w health-checks.yml --limit 1 --json conclusion --jq '.[0].conclusion // empty')" = success ] \
  || pre "la última ejecución de health-checks.yml en $DEPLOY no está en verde"
gh api "repos/$WEB/contents/.github/workflows/daily-health-checks.yml" >/dev/null 2>&1 \
  && pre "daily-health-checks.yml sigue en main de wedding-invite-2 (usa estos secretos): quítalo antes (fase 6)"
[ "$(gh run list -R dieg092/seo-agent --limit 20 --json conclusion,event --jq '[.[] | select(.event=="schedule" or .event=="workflow_dispatch") | select(.conclusion=="success")] | length')" -gt 0 ] \
  || pre "ningún workflow reciente de seo-agent en verde con el entorno produccion"
echo "  ✓ todo en orden"

echo "wedding-invite-2:"
for n in $(gh api "repos/dieg092/wedding-invite-2/actions/secrets?per_page=100" --jq '.secrets[].name'); do
  if [[ " $KEEP_WEB " == *" $n "* ]]; then echo "  = $n (se queda)"; continue; fi
  gh secret delete "$n" -R dieg092/wedding-invite-2 && echo "  − $n"
done

echo "seo-agent (secretos de repositorio; los del entorno produccion se quedan):"
env_names=" $(gh api repos/dieg092/seo-agent/environments/produccion/secrets --jq '[.secrets[].name]|join(" ")') "
for n in $(gh api "repos/dieg092/seo-agent/actions/secrets?per_page=100" --jq '.secrets[].name'); do
  if [[ "$env_names" != *" $n "* ]]; then echo "  ! $n no está en el entorno produccion: no se borra"; continue; fi
  gh secret delete "$n" -R dieg092/seo-agent && echo "  − $n"
done
