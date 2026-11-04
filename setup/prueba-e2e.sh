#!/usr/bin/env bash
# Prueba de extremo a extremo del camino rama de IA → CI → aprobación → fusión →
# validación de main → despliegue autorizado. La lanza el propietario cuando ya
# están los secretos (configurar-secretos.sh) y la rama de seguridad fusionada:
#
#   bash ~/Projects/infra/miwebdeboda-deploy/setup/prueba-e2e.sh
#
# Qué cambia en producción: publica public/deploy-probe.txt (un texto con una
# marca aleatoria) y un comentario en .vercelignore, y al final los quita con
# otro despliegue. Nada más. Cada paso que toca main pide confirmación.
set -euo pipefail

APP=dieg092/wedding-invite-2
DEPLOY=dieg092/miwebdeboda-deploy
WEB=~/Projects/production/miwebdeboda/wedding-invite-2
HERE=$(cd "$(dirname "$0")/.." && pwd)
NONCE=$(openssl rand -hex 8)
BRANCH="ia/prueba-despliegue-$(date +%Y%m%d-%H%M)"
WT=$(mktemp -d)/wt
ok() { echo "  ✓ $*"; }
ko() { echo "  ✗ $*"; exit 1; }
confirm() { read -r -p "$1 Escribe «si»: " a </dev/tty; [ "$a" = si ] || { echo "Parado."; exit 1; }; }

# espera_ci SHA → conclusión de la CI de ese commit
espera_ci() {
  local id=""
  for _ in $(seq 1 60); do id=$(gh api "repos/$APP/actions/workflows/ci.yml/runs?head_sha=$1" --jq '.workflow_runs[0].id // empty'); [ -n "$id" ] && break; sleep 20; done
  [ -n "$id" ] || ko "no arranca la CI de $1"
  gh run watch "$id" -R "$APP" --exit-status >/dev/null 2>&1 || true
  echo "$id $(gh api "repos/$APP/actions/runs/$id" --jq .conclusion)"
}
# despliegue_tras FECHA → id del primer deploy.yml creado después
despliegue_tras() {
  local id=""
  for _ in $(seq 1 45); do
    id=$(gh run list -R "$DEPLOY" -w deploy.yml --json databaseId,createdAt --jq "[.[] | select(.createdAt > \"$1\")] | sort_by(.createdAt) | .[0].databaseId // empty")
    [ -n "$id" ] && break; sleep 20
  done
  echo "$id"
}
lanza() { # lanza [sha] → id del run
  local t; t=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run deploy.yml -R "$DEPLOY" ${1:+-f sha="$1"} >/dev/null
  despliegue_tras "$t"
}
fin_run() { gh run watch "$1" -R "$DEPLOY" --exit-status >/dev/null 2>&1 && echo success || echo failure; }
log_verify() { gh run view "$1" -R "$DEPLOY" --log 2>/dev/null | grep -m1 "::error::\|Desplegable:" | sed 's/.*::error:://; s/.*Desplegable/Desplegable/' | cut -c1-200; }

echo "1. Commit en una rama de IA ($BRANCH)"
git -C "$WEB" fetch -q origin
git -C "$WEB" worktree add -q -b "$BRANCH" "$WT" origin/main
printf 'prueba de despliegue %s\n' "$NONCE" > "$WT/public/deploy-probe.txt"
printf '\n# prueba-e2e %s\n' "$NONCE" >> "$WT/.vercelignore"   # fichero protegido: exige aprobación
git -C "$WT" add public/deploy-probe.txt .vercelignore
git -C "$WT" commit -qm "prueba de despliegue $NONCE"
SHA=$(git -C "$WT" rev-parse HEAD)
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git -C "$WT" push -q origin "$BRANCH"
ok "rama subida ($SHA)"

echo "2. CI de la rama (sin secretos de producción, sin desplegar)"
read -r RUN CONC < <(espera_ci "$SHA")
[ "$CONC" = success ] && ok "CI en verde (run $RUN)" || ko "la CI de la rama falla (run $RUN)"
STEP=$(gh api "repos/$APP/actions/runs/$RUN/jobs" --jq '.jobs[0].steps[] | select(.name=="Request production deploy") | .conclusion')
[ "$STEP" = skipped ] && ok "la rama no pide despliegue" || ko "la rama pidió despliegue ($STEP)"
[ -z "$(gh run list -R "$DEPLOY" -w deploy.yml --json createdAt --jq "[.[] | select(.createdAt > \"$START\")][0] // empty")" ] && ok "ningún despliegue lanzado" || ko "se lanzó un despliegue desde la rama"

echo "3. Intentos de saltarse la puerta"
R=$(lanza "$SHA"); [ "$(fin_run "$R")" = failure ] && ok "desplegar el commit de la rama: rechazado ($(log_verify "$R"))" || ko "¡se aceptó el commit de la rama!"
R=$(lanza 'main;id'); [ "$(fin_run "$R")" = failure ] && ok "sha con inyección: rechazado ($(log_verify "$R"))" || ko "¡se aceptó un sha inválido!"

echo "4. Fusión en main (la hace el propietario; Órbita solo prepara el PR)"
confirm "¿Fusionar $BRANCH en main?"
git -C "$WT" fetch -q origin
git -C "$WT" rebase -q origin/main
SHA=$(git -C "$WT" rev-parse HEAD)
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git -C "$WT" push -q origin "HEAD:main"
ok "main = $SHA"

echo "5. Validación de main y primer intento de despliegue (debe pararse: .vercelignore cambió)"
read -r RUN CONC < <(espera_ci "$SHA")
[ "$CONC" = success ] && ok "CI de main en verde (run $RUN)" || ko "la CI de main falla (run $RUN)"
R=$(despliegue_tras "$START"); [ -n "$R" ] || ko "la CI de main no lanzó el despliegue"
[ "$(fin_run "$R")" = failure ] && ok "despliegue parado sin aprobación ($(log_verify "$R"))" || ko "¡se desplegó un fichero protegido sin aprobar!"

echo "6. Aprobación del propietario"
bash "$HERE/scripts/aprobar.sh" huella "$SHA" "prueba e2e $NONCE"

echo "7. Despliegue autorizado"
R=$(lanza "$SHA"); C=$(fin_run "$R")
[ "$C" = success ] && ok "desplegado (run $R): $(log_verify "$R")" || ko "el despliegue falla (run $R)"
sleep 10
[ "$(curl -fsS "https://miwebdeboda.com/deploy-probe.txt")" = "prueba de despliegue $NONCE" ] && ok "producción sirve la marca $NONCE" || ko "producción no sirve la marca"
REC=$(gh api "repos/$DEPLOY/deployments?environment=produccion&per_page=1" --jq '.[0].payload.app_sha')
[ "$REC" = "$SHA" ] && ok "despliegue registrado (base para el siguiente)" || ko "no se registró el despliegue"

echo "8. Limpieza (otro despliegue; .vercelignore vuelve a su huella ya aprobada)"
confirm "¿Quitar los ficheros de prueba de main y desplegar?"
git -C "$WT" fetch -q origin && git -C "$WT" rebase -q origin/main
git -C "$WT" rm -q public/deploy-probe.txt
git -C "$WT" show "$SHA~1:.vercelignore" > "$WT/.vercelignore"
git -C "$WT" add .vercelignore && git -C "$WT" commit -qm "quita la prueba de despliegue"
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git -C "$WT" push -q origin "HEAD:main"
read -r RUN CONC < <(espera_ci "$(git -C "$WT" rev-parse HEAD)")
R=$(despliegue_tras "$START")
[ "$(fin_run "$R")" = success ] && ok "limpieza desplegada sin nueva aprobación" || ko "la limpieza no se desplegó (run $R)"
git -C "$WEB" worktree remove --force "$WT"; git -C "$WEB" branch -q -D "$BRANCH"; git -C "$WEB" push -q origin --delete "$BRANCH"
echo "Prueba completa."
