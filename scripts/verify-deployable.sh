#!/usr/bin/env bash
# Decide si un commit de wedding-invite-2 se puede desplegar a producción. Es la
# única puerta al despliegue y vive aquí, fuera del repositorio que escriben las
# tareas de IA, para que ninguna rama pueda saltársela ni cambiarla.
#
# Se despliega solo si:
#   1. el commit es el HEAD actual de main (nunca uno antiguo ni de otra rama);
#   2. hay una ejecución de .github/workflows/ci.yml en main, por push, sobre ese
#      commit exacto, terminada en éxito (las ramas no pueden crear ejecuciones de
#      push en main, así que no se puede falsificar);
#   3. el ci.yml de ese commit es uno aprobado (approved-ci.sha1): si alguien
#      debilita la CI en main, no se despliega hasta que el propietario revise y
#      apruebe el nuevo ci.yml aquí.
#
# Entradas: APP_REPO, GH_TOKEN (lectura de wedding-invite-2), REQUESTED (sha o vacío).
# Salida: sha=<commit> en $GITHUB_OUTPUT.
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

: "${APP_REPO:?}" "${GH_TOKEN:?falta APP_READ_TOKEN}"
here="$(cd "$(dirname "$0")/.." && pwd)"

head=$(gh api "repos/$APP_REPO/commits/main" --jq .sha)
sha="${REQUESTED:-$head}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "sha no válido: '$sha' (hace falta el sha completo de 40 caracteres)"
[ "$sha" = "$head" ] || fail "$sha no es el HEAD de main ($head). Solo se despliega el último commit de main; para volver atrás, usad el rollback de Vercel (README)."

runs=$(gh api "repos/$APP_REPO/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$sha&status=success&per_page=10" \
  --jq '[.workflow_runs[] | select(.head_branch == "main" and .event == "push" and .path == ".github/workflows/ci.yml" and .conclusion == "success" and .head_sha == "'"$sha"'")] | length')
[ "${runs:-0}" -ge 1 ] || fail "la CI de main no ha terminado en verde sobre $sha: no se despliega"

ci_blob=$(gh api "repos/$APP_REPO/contents/.github/workflows/ci.yml?ref=$sha" --jq .sha)
grep -qx "$ci_blob" <(grep -v '^\s*#' "$here/approved-ci.sha1" | awk '{print $1}') \
  || fail "el ci.yml de $sha ($ci_blob) no está aprobado. Si el cambio de la CI es correcto, añadid su hash a approved-ci.sha1 en miwebdeboda-deploy."

echo "Desplegable: $sha (HEAD de main, CI en verde, ci.yml aprobado $ci_blob)"
echo "sha=$sha" >> "${GITHUB_OUTPUT:-/dev/null}"
