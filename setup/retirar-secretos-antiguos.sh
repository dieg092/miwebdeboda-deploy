#!/usr/bin/env bash
# Último paso del cambio: borra de wedding-invite-2 todos los secretos salvo los
# dos que no son de producción, y de seo-agent los secretos de repositorio (sus
# workflows ya los leen del entorno «produccion»). Ejecutar solo después de:
#   - un despliegue correcto desde miwebdeboda-deploy, y
#   - una ejecución correcta de un workflow de seo-agent con environment: produccion.
set -euo pipefail
KEEP_WEB="STRIPE_TEST_SECRET_KEY DEPLOY_DISPATCH_TOKEN"

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
