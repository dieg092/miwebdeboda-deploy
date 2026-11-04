#!/usr/bin/env bash
# Comprueba que cada token tiene solo los permisos que necesita ANTES de guardarlo.
# Lo usa configurar-secretos.sh; también se puede lanzar suelto:
#
#   bash setup/comprobar-tokens.sh            # pide los tokens sin eco y los comprueba
#
# Las pruebas de escritura no cambian nada: todas piden algo inválido (una rama
# que apunta a un commit inexistente, una rama que no existe, un valor no válido).
# Con permiso, GitHub responde 422 (dato inválido); sin permiso, 403/404. El token nunca va en la línea de órdenes (curl -K -).
set -euo pipefail

CK_APP=dieg092/wedding-invite-2
CK_DEPLOY=dieg092/miwebdeboda-deploy
CK_SEO=dieg092/seo-agent
ZERO=0000000000000000000000000000000000000000

# gh_status TOKEN MÉTODO RUTA [JSON] → código HTTP
gh_status() {
  local t=$1 m=$2 p=$3 body=${4:-}
  printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -s -o /dev/null -w '%{http_code}' -K - \
    -X "$m" -H "Accept: application/vnd.github+json" ${body:+-d "$body"} "https://api.github.com/$p"
}
# gh_expiry TOKEN → fecha de caducidad (cabecera de GitHub) o vacío
gh_expiry() {
  printf 'header = "Authorization: Bearer %s"\n' "$1" | curl -s -D - -o /dev/null -K - "https://api.github.com/repos/$CK_APP" \
    | awk -F': ' 'tolower($1)=="github-authentication-token-expiration"{print $2}' | tr -d '\r'
}

fails=0
expect() { # expect DESCRIPCIÓN OBTENIDO ESPERADO...
  local d=$1 got=$2; shift 2
  for want in "$@"; do [ "$got" = "$want" ] && { echo "    ✓ $d"; return; }; done
  echo "    ✗ $d (GitHub respondió $got)"; fails=$((fails + 1))
}
write_probe() { gh_status "$1" POST "repos/$2/git/refs" "{\"ref\":\"refs/heads/comprobacion-permisos\",\"sha\":\"$ZERO\"}"; }

check_github_common() { # TOKEN NOMBRE
  case $1 in
    github_pat_*) echo "    ✓ es fine-grained" ;;
    *) echo "    ✗ no es un token fine-grained (github_pat_…): los clásicos dan acceso a todos los repositorios"; fails=$((fails + 1)) ;;
  esac
  local exp; exp=$(gh_expiry "$1")
  if [ -n "$exp" ]; then echo "    ✓ caduca: $exp"; else echo "    ✗ no caduca: poned una caducidad (90 días recomendado)"; fails=$((fails + 1)); fi
}

check_app_read_token() {
  local t=$1; echo "  APP_READ_TOKEN (Contents y Actions de solo lectura, solo wedding-invite-2):"
  check_github_common "$t"
  expect "lee wedding-invite-2" "$(gh_status "$t" GET "repos/$CK_APP/contents/package.json")" 200
  expect "lee las ejecuciones de su CI" "$(gh_status "$t" GET "repos/$CK_APP/actions/runs?per_page=1")" 200
  expect "no puede escribir código ni ramas en wedding-invite-2" "$(write_probe "$t" "$CK_APP")" 403 404
  expect "no ve los secretos de wedding-invite-2" "$(gh_status "$t" GET "repos/$CK_APP/actions/secrets")" 403 404
  expect "no puede lanzar workflows" "$(gh_status "$t" POST "repos/$CK_APP/actions/workflows/ci.yml/dispatches" '{"ref":"refs/heads/no-existe-comprobacion-permisos"}')" 403 404
  expect "no ve miwebdeboda-deploy" "$(gh_status "$t" GET "repos/$CK_DEPLOY")" 404 403
  expect "no ve seo-agent por API privada" "$(gh_status "$t" GET "repos/$CK_SEO/actions/secrets")" 403 404
}

check_dispatch_token() {
  local t=$1; echo "  DEPLOY_DISPATCH_TOKEN (Actions de lectura y escritura, solo miwebdeboda-deploy):"
  check_github_common "$t"
  expect "ve los workflows de miwebdeboda-deploy" "$(gh_status "$t" GET "repos/$CK_DEPLOY/actions/workflows")" 200
  expect "no lee el código de miwebdeboda-deploy" "$(gh_status "$t" GET "repos/$CK_DEPLOY/contents/README.md")" 403 404
  expect "no puede escribir código, ramas ni workflows" "$(write_probe "$t" "$CK_DEPLOY")" 403 404
  expect "no ve ni cambia secretos" "$(gh_status "$t" GET "repos/$CK_DEPLOY/actions/secrets")" 403 404
  expect "no cambia los ajustes del repositorio" "$(gh_status "$t" PATCH "repos/$CK_DEPLOY" '{"visibility":"no-valida"}')" 403 404
  expect "no crea registros de despliegue (la base de la comprobación de tests)" "$(gh_status "$t" POST "repos/$CK_DEPLOY/deployments" '{"ref":"refs/heads/no-existe-comprobacion-permisos"}')" 403 404
  expect "puede lanzar deploy.yml (lo único que necesita)" "$(gh_status "$t" POST "repos/$CK_DEPLOY/actions/workflows/deploy.yml/dispatches" '{"ref":"refs/heads/no-existe-comprobacion-permisos"}')" 422
  expect "no ve wedding-invite-2" "$(gh_status "$t" GET "repos/$CK_APP")" 404 403
}

# check_vercel_token TOKEN PROJECT_ID
check_vercel_token() {
  local t=$1 project=$2; echo "  VERCEL_TOKEN:"
  local meta; meta=$(printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -s -K - "https://api.vercel.com/v5/user/tokens/current")
  node -e '
    const m = JSON.parse(process.argv[1]).token ?? {}; const project = process.argv[2]; let bad = 0;
    const say = (ok, msg) => { console.log(`    ${ok ? "✓" : "✗"} ${msg}`); if (!ok) bad++; };
    say(!!m.id, "Vercel lo reconoce");
    say(!!m.expiresAt, m.expiresAt ? `caduca: ${new Date(Number(m.expiresAt)).toISOString().slice(0, 10)}` : "no caduca: poned una caducidad");
    const p = m.projectId ?? (m.scopes ?? []).map((s) => s.projectId).find(Boolean);
    if (p) say(p === project, `limitado al proyecto ${p === project ? "de la web" : p}`);
    else console.log("    ! no está limitado a un proyecto: Vercel lo deja usar en todo el equipo (riesgo residual, README)");
    process.exit(bad ? 1 : 0);' "$meta" "$project" || fails=$((fails + 1))
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  read -r -s -p "APP_READ_TOKEN (Enter para saltar): " a </dev/tty; echo
  read -r -s -p "DEPLOY_DISPATCH_TOKEN (Enter para saltar): " d </dev/tty; echo
  [ -n "$a" ] && check_app_read_token "$a"
  [ -n "$d" ] && check_dispatch_token "$d"
  [ "$fails" -eq 0 ] && echo "Todo correcto." || { echo "$fails comprobaciones fallan: rehaced esos tokens."; exit 1; }
fi
