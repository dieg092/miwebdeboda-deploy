#!/usr/bin/env bash
# Pasa el monitor sintético (y el chequeo live de Stripe) de
# dieg092/miwebdeboda-synthetic-monitor a este repositorio sin dejar ningún día
# sin monitor y sin que los dos usen a la vez la cuenta canario:
#
#   1. comprueba que el antiguo no está corriendo;
#   2. lanza el nuevo a mano y espera a que termine en verde (si no, no cambia nada);
#   3. solo entonces desactiva los antiguos y activa los nuevos.
#
#   bash setup/cambiar-monitor.sh            # cambio
#   bash setup/cambiar-monitor.sh --volver   # vuelta atrás: reactiva los antiguos
#
# Requisitos: configurar-secretos.sh hecho y al menos un despliegue desde este
# repositorio que incluya el arreglo del banner de cookies del spec sintético
# (el monitor nuevo ejecuta el commit desplegado).
set -euo pipefail
OLD=dieg092/miwebdeboda-synthetic-monitor
NEW=dieg092/miwebdeboda-deploy
OLD_WF=(synthetic-monitor.yml live-stripe-check.yml)
NEW_WF=(monitor-sintetico.yml stripe-live.yml)

if [ "${1:-}" = "--volver" ]; then
  for w in "${NEW_WF[@]}"; do gh workflow disable "$w" -R $NEW && echo "  − $NEW $w"; done
  for w in "${OLD_WF[@]}"; do gh workflow enable "$w" -R $OLD && echo "  + $OLD $w"; done
  echo "Vuelto al monitor antiguo."; exit 0
fi

echo "1. ¿Está corriendo el monitor antiguo?"
busy=$(gh run list -R $OLD --status in_progress --json databaseId --jq length)
[ "$busy" = 0 ] || { echo "  hay $busy ejecuciones en curso en $OLD: espera a que terminen"; exit 1; }
echo "  no"

echo "2. Prueba del monitor nuevo (dispatch manual)"
gh workflow enable monitor-sintetico.yml -R $NEW
t=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run monitor-sintetico.yml -R $NEW
id=""; for _ in $(seq 1 30); do
  id=$(gh run list -R $NEW -w monitor-sintetico.yml --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$t\")][0].databaseId // empty")
  [ -n "$id" ] && break; sleep 5
done
[ -n "$id" ] || { gh workflow disable monitor-sintetico.yml -R $NEW; echo "  no arrancó"; exit 1; }
if ! gh run watch "$id" -R $NEW --exit-status >/dev/null 2>&1; then
  gh workflow disable monitor-sintetico.yml -R $NEW
  echo "  ✗ el monitor nuevo falla (run $id): el antiguo sigue activo, no se ha cambiado nada"; exit 1
fi
echo "  ✓ en verde (run $id)"

echo "3. Cambio"
for w in "${OLD_WF[@]}"; do gh workflow disable "$w" -R $OLD && echo "  − $OLD $w"; done
for w in "${NEW_WF[@]}"; do gh workflow enable "$w" -R $NEW && echo "  + $NEW $w"; done
cat <<TXT

Hecho. El repositorio antiguo queda con sus workflows desactivados (no se borra
nada). Cuando el nuevo lleve unos días en verde: borrar sus secretos
(gh secret list -R $OLD) y rotar los que compartía (ROTACION.md, filas 10, 11 y 18).
TXT
