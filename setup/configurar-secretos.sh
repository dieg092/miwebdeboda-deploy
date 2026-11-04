#!/usr/bin/env bash
# Pone los secretos de producción donde deben estar. Lo ejecuta el propietario
# (no una tarea de IA). Ningún valor se escribe en disco fuera de un directorio
# temporal que se borra al terminar, ni se muestra en pantalla.
#
#   bash ~/Projects/infra/miwebdeboda-deploy/setup/configurar-secretos.sh
#
# Necesita: gh con sesión iniciada y el CLI de Vercel con acceso al proyecto
# (lo trae wedding-invite-2: pnpm exec vercel).
set -euo pipefail

WEB=~/Projects/production/miwebdeboda/wedding-invite-2
SEO=~/Projects/production/miwebdeboda/seo-agent
DEPLOY_REPO=dieg092/miwebdeboda-deploy
WEB_REPO=dieg092/wedding-invite-2
SEO_REPO=dieg092/seo-agent

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

envval() { # envval FICHERO NOMBRE → valor sin comillas ("" si no está)
  awk -v k="$2" 'index($0, k "=") == 1 { sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); gsub(/^\x27|\x27$/, ""); print; exit }' "$1" 2>/dev/null || true
}
put() { # put REPO NOMBRE VALOR [entorno]
  local repo=$1 name=$2 value=$3 env=${4:-}
  if [ -z "$value" ]; then echo "  · $name: sin valor, se omite"; return; fi
  if [ -n "$env" ]; then printf '%s' "$value" | gh secret set "$name" -R "$repo" --env "$env" >/dev/null
  else printf '%s' "$value" | gh secret set "$name" -R "$repo" >/dev/null; fi
  echo "  ✓ $name → $repo${env:+ (entorno $env)}"
}
ask() { # ask "texto" → lee sin eco
  local v; read -r -s -p "$1: " v </dev/tty; echo >&2; printf '%s' "$v"
}

echo "1/4 Valores de producción desde Vercel (vercel env pull, a un temporal que se borra)"
(cd "$WEB" && pnpm exec vercel env pull "$tmp/prod.env" --environment=production --yes >/dev/null)
P="$tmp/prod.env"
ORG=$(node -p "require('$WEB/.vercel/project.json').orgId")
PROJ=$(node -p "require('$WEB/.vercel/project.json').projectId")

cat <<'TXT'

2/4 Tokens que hay que crear a mano (no se pueden crear por API). Todos con caducidad (90 días):

  a) APP_READ_TOKEN — https://github.com/settings/personal-access-tokens/new
     Fine-grained · Only select repositories: wedding-invite-2
     Permisos de repositorio: Contents = Read-only, Actions = Read-only (Metadata va solo). Nada más.
  b) DEPLOY_DISPATCH_TOKEN — mismo sitio, otro token
     Only select repositories: miwebdeboda-deploy · Actions = Read and write. Nada más.
  c) VERCEL_TOKEN — https://vercel.com/account/settings/tokens, nuevo, con caducidad,
     limitado al equipo del proyecto (y al proyecto si Vercel lo ofrece).
  d) Telegram (opcional): el token del bot y el chat id que ya usabais.

Cada token se comprueba antes de guardarlo (setup/comprobar-tokens.sh): si tiene
más permisos de los necesarios, no se guarda nada.

TXT
APP_READ_TOKEN=$(ask "APP_READ_TOKEN")
DEPLOY_DISPATCH_TOKEN=$(ask "DEPLOY_DISPATCH_TOKEN")
VERCEL_TOKEN=$(ask "VERCEL_TOKEN")
TG_TOKEN=$(ask "TELEGRAM_BOT_TOKEN (Enter para omitir)")
TG_CHAT=$(ask "TELEGRAM_CHAT_ID (Enter para omitir)")

echo "Comprobando permisos de los tokens:"
# shellcheck source=comprobar-tokens.sh
source "$(dirname "$0")/comprobar-tokens.sh"
check_app_read_token "$APP_READ_TOKEN"
check_dispatch_token "$DEPLOY_DISPATCH_TOKEN"
check_vercel_token "$VERCEL_TOKEN" "$PROJ"
if [ "$fails" -ne 0 ]; then echo "$fails comprobaciones fallan: no se ha guardado nada. Rehaced esos tokens y volved a lanzar el script."; exit 1; fi

echo "3/4 Secretos de miwebdeboda-deploy y el token de despacho de wedding-invite-2"
put $DEPLOY_REPO APP_READ_TOKEN "$APP_READ_TOKEN"
put $DEPLOY_REPO VERCEL_TOKEN "$VERCEL_TOKEN"
put $DEPLOY_REPO VERCEL_ORG_ID "$ORG"
put $DEPLOY_REPO VERCEL_PROJECT_ID "$PROJ"
for n in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION RESEND_API_KEY EMAIL_FROM SYNTHETIC_MONITOR_EMAIL; do
  v=$(envval "$P" $n); [ -z "$v" ] && v=$(ask "$n (no está en Vercel o es «sensitive»)")
  put $DEPLOY_REPO $n "$v"
done
v=$(envval "$P" DATABASE_URL); [ -z "$v" ] && v=$(ask "PROD_DATABASE_URL"); put $DEPLOY_REPO PROD_DATABASE_URL "$v"
v=$(envval "$P" DIRECT_URL); [ -z "$v" ] && v=$(ask "PROD_DIRECT_URL"); put $DEPLOY_REPO PROD_DIRECT_URL "$v"
put $DEPLOY_REPO TELEGRAM_BOT_TOKEN "$TG_TOKEN"
put $DEPLOY_REPO TELEGRAM_CHAT_ID "$TG_CHAT"
put $WEB_REPO DEPLOY_DISPATCH_TOKEN "$DEPLOY_DISPATCH_TOKEN"

echo "   Monitor sintético (se activa después con setup/cambiar-monitor.sh)"
v=$(envval "$P" JWT_SECRET); [ -z "$v" ] && v=$(ask "PROD_JWT_SECRET (JWT_SECRET de producción)"); put $DEPLOY_REPO PROD_JWT_SECRET "$v"
v=$(envval "$P" SYNTHETIC_MONITOR_SECRET); [ -z "$v" ] && v=$(ask "SYNTHETIC_MONITOR_SECRET"); put $DEPLOY_REPO SYNTHETIC_MONITOR_SECRET "$v"
v=$(envval "$WEB/.env" STRIPE_TEST_SECRET_KEY); [ -z "$v" ] && v=$(ask "STRIPE_TEST_SECRET_KEY (sk_test_…)"); put $DEPLOY_REPO STRIPE_TEST_SECRET_KEY "$v"
put $DEPLOY_REPO LIVE_CANARY_EMAIL "$(ask "LIVE_CANARY_EMAIL del chequeo live de Stripe (Enter para omitir)")"
put $DEPLOY_REPO STRIPE_LIVE_RESTRICTED_KEY "$(ask "STRIPE_LIVE_RESTRICTED_KEY: crea una nueva en Stripe (rk_live_…, mismos permisos que la actual) (Enter para omitir)")"
read -r -p "   ¿Poner ahora los proxies ES/MX/US del monitor regional (solo dispatch manual)? [s/N] " px </dev/tty
if [ "$px" = s ]; then
  for r in ES MX US; do for k in SERVER USERNAME PASSWORD; do put $DEPLOY_REPO PROXY_${r}_$k "$(ask "PROXY_${r}_$k")"; done; done
fi

echo "4/4 seo-agent: los mismos secretos que hoy, en el entorno «produccion» (solo main)"
for n in $(gh api "repos/$SEO_REPO/actions/secrets?per_page=100" --jq '.secrets[].name'); do
  case $n in
    TELEGRAM_BOT_TOKEN) v=$TG_TOKEN ;;
    TELEGRAM_CHAT_ID) v=$TG_CHAT ;;
    *) v=$(envval "$SEO/.env" $n); [ -z "$v" ] && v=$(ask "$n de seo-agent (no está en su .env)") ;;
  esac
  put $SEO_REPO $n "$v" produccion
done

echo "Activando las comprobaciones diarias de producción (health-checks.yml, 09:15 UTC)."
echo "Las antiguas de wedding-invite-2 siguen activas hasta comprobar las nuevas (MIGRACION.md)."
gh workflow enable health-checks.yml -R $DEPLOY_REPO

echo
echo "Hecho. Los secretos antiguos de wedding-invite-2 y los de repositorio de seo-agent"
echo "siguen puestos: se borran después de comprobar el primer despliegue y el primer"
echo "workflow de seo-agent con el entorno nuevo (setup/retirar-secretos-antiguos.sh)."
