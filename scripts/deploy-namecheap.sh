#!/usr/bin/env bash
set -euo pipefail
umask 077

app_root="${1:?Falta la raíz de la aplicación}"
node_env="${2:?Falta el archivo de activación de Node.js}"
archive="${3:?Falta el paquete de despliegue}"
revision="${4:?Falta el commit}"

[[ "$app_root" =~ ^/home/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$ ]] || { echo 'Ruta de aplicación inválida.' >&2; exit 1; }
[[ "$node_env" =~ ^/home/[A-Za-z0-9_.-]+/nodevenv/[A-Za-z0-9_./-]+/bin/activate$ ]] || { echo 'Ruta del entorno Node.js inválida.' >&2; exit 1; }
[[ "$archive" =~ ^/tmp/gympass-upload\.[A-Za-z0-9]+/release\.tar\.gz$ && -f "$archive" ]] || { echo 'Paquete inválido.' >&2; exit 1; }
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Commit inválido.' >&2; exit 1; }
[[ -d "$app_root" && -f "$node_env" ]] || { echo 'Configura primero la aplicación Node.js en cPanel.' >&2; exit 1; }

app_root="$(realpath "$app_root")"
[[ "$app_root" == "$HOME/"* && "$app_root" != "$HOME" ]] || { echo 'La aplicación debe pertenecer a esta cuenta.' >&2; exit 1; }

set +u
source "$node_env"
set -u
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo 'GymPASS requiere Node.js 24 o posterior.' >&2; exit 1; }
command -v rsync >/dev/null || { echo 'El servidor necesita rsync.' >&2; exit 1; }

while IFS= read -r entry; do
  case "$entry" in
    app.js|package.json|package-lock.json|lib|lib/*|server|server/*|scripts|scripts/*|dist|dist/*) ;;
    *) echo 'El paquete contiene una ruta que no pertenece a la aplicación.' >&2; exit 1 ;;
  esac
  [[ "$entry" != /* && "$entry" != *../* && "$entry" != *\\* ]] || exit 1
done < <(tar -tzf "$archive")

staging="$(mktemp -d "$HOME/.gympass-release.XXXXXXXX")"
tar -xzf "$archive" -C "$staging" --no-same-owner
[[ -f "$staging/app.js" && -f "$staging/package-lock.json" && -f "$staging/dist/index.html" ]] || { echo 'Entrega incompleta.' >&2; exit 1; }

backup_root="$HOME/gympass-code-backups"
mkdir -p "$backup_root"
previous=()
for entry in app.js package.json package-lock.json lib server scripts dist; do
  if [[ -e "$app_root/$entry" ]]; then previous+=("$entry"); fi
done
if ((${#previous[@]})); then
  tar -czf "$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}.tar.gz" \
    --exclude=node_modules --exclude=data --exclude=platform-data --exclude=backups \
    --exclude='*.sqlite*' --exclude='.env*' -C "$app_root" "${previous[@]}"
fi

# No --delete: preserve cPanel configuration, uploaded assets and persistent data.
rsync -a --delay-updates "$staging/" "$app_root/"
cd "$app_root"
npm install --omit=dev --ignore-scripts --no-audit --no-fund
mkdir -p tmp
printf '%s\n' "$revision" > tmp/deployed-commit
touch tmp/restart.txt
node scripts/restart-namecheap.mjs "$app_root"
printf 'Código actualizado al commit %s. Reinicio solicitado a Passenger.\n' "$revision"
if [[ "$staging" == "$HOME/.gympass-release."* ]]; then rm -rf -- "$staging"; fi
rm -f -- "$archive"
rmdir -- "${archive%/*}"
