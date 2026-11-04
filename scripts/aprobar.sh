#!/usr/bin/env bash
# Aprueba, después de revisarlo, lo que el despliegue no deja pasar solo:
#
#   bash scripts/aprobar.sh huella <sha>   ficheros protegidos de ese commit (CI, dependencias, migraciones…)
#   bash scripts/aprobar.sh commit <sha>   tests borrados o desactivados hasta ese commit
#
# Enseña lo que se aprueba, pide confirmación, añade la línea a aprobaciones.txt,
# hace commit y push. Lo ejecuta el propietario con su sesión de gh.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=dieg092/wedding-invite-2
kind=${1:?huella|commit}; sha=${2:?sha completo}; motivo=${3:-}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "sha no válido"; exit 1; }
base=$(grep -v '^\s*#' base-inicial.txt | head -1)
last=$(gh api "repos/dieg092/miwebdeboda-deploy/deployments?environment=produccion&per_page=1" --jq '.[0].payload.app_sha // empty' 2>/dev/null || true)
base=${last:-$base}
echo "Cambios desde lo último desplegado (${base:0:7}) hasta ${sha:0:7}:"
case $kind in
  huella)
    fp=$(GH_TOKEN=$(gh auth token) node --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { fingerprint, protectedMatcher, github } from './scripts/verify-deployable.mjs';
      const api = github(process.env.GH_TOKEN);
      const t = await api('repos/$APP/git/trees/$sha?recursive=1');
      const m = protectedMatcher(readFileSync('protegido.txt','utf8'));
      const c = await api('repos/$APP/compare/$base...$sha?per_page=100');
      for (const f of c.files ?? []) if (m(f.filename) || (f.previous_filename && m(f.previous_filename))) console.error('  ' + f.status.padEnd(9) + f.filename);
      console.log(fingerprint(t.tree, m).fingerprint);")
    line="huella $fp $(date +%F) ${sha:0:12} ${motivo:-}"
    echo "(diff completo: gh api repos/$APP/compare/$base...$sha -H 'Accept: application/vnd.github.diff' | less)";;
  commit)
    gh api "repos/$APP/compare/$base...$sha?per_page=100" --jq '.files[] | select(.filename|test("\\.(test|spec)\\.[cm]?[jt]sx?$")) | "  \(.status)\t\(.filename)"'
    line="commit $sha $(date +%F) ${motivo:-}";;
  *) echo "uso: aprobar.sh huella|commit <sha> [motivo]"; exit 1;;
esac
echo; read -r -p "¿Aprobar? Escribe «si»: " ok </dev/tty
[ "$ok" = "si" ] || { echo "No aprobado."; exit 1; }
echo "$line" >> aprobaciones.txt
git add aprobaciones.txt && git commit -qm "aprueba $kind de ${sha:0:7}" && git push -q
echo "Aprobado y subido. Relanzad el despliegue: gh workflow run deploy.yml -R dieg092/miwebdeboda-deploy"
