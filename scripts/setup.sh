#!/bin/sh
# Installs a12s Studio for this user: checks the tools, starts the Fleet once, writes the config and the
# LaunchAgents. Safe to run again. Usage: scripts/setup.sh [--owner-login you@example.com]
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${STUDIO_HOME:-$HOME/.a12s-studio}
fleet_file=$home/fleet/fleet.yaml
logs=$HOME/Library/Logs/a12s-studio
agents=$HOME/Library/LaunchAgents
owner_login=

while [ $# -gt 0 ]; do
  case $1 in
    --owner-login) owner_login=${2:?--owner-login needs a value}; shift 2 ;;
    --owner-login=*) owner_login=${1#*=}; shift ;;
    *) echo "usage: $0 [--owner-login you@example.com]" >&2; exit 2 ;;
  esac
done

die() { printf 'setup: %s\n' "$1" >&2; exit 1; }
# at_least <version> <minimum>: true when version >= minimum, comparing numeric parts.
at_least() {
  echo "$1 $2" | awk '{ split($1, a, "."); split($2, b, ".")
    for (i = 1; i <= 3; i++) { if (a[i] + 0 > b[i] + 0) exit 0; if (a[i] + 0 < b[i] + 0) exit 1 } exit 0 }'
}

command -v docker >/dev/null || die "Docker is not installed. Install Docker Desktop, start it, and run this again."
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and run this again."
command -v a12s >/dev/null || die "a12s is not installed: brew install coltonkirsten/tap/a12s"
a12s_version=$(a12s version | sed -n 's/^a12s v\([0-9.]*\).*/\1/p')
at_least "${a12s_version:-0}" 0.11.1 || die "a12s ${a12s_version:-?} is too old; 0.11.1 or later is needed: brew upgrade a12s"
command -v node >/dev/null || die "Node.js is not installed. Install Node 24 or later."
node=$(command -v node)
at_least "$(node -p process.versions.node)" 24.0.0 || die "Node $(node -p process.versions.node) is too old; 24 or later is needed."

mkdir -p "$home/fleet"
chmod 700 "$home"

# The Fleet file names the Fleet and nothing else: the app creates every agent computer. a12s up runs only the
# first time, because running it again would remove every agent computer the app has created since.
if [ ! -f "$HOME/.a12s/studio/controller.json" ]; then
  [ -f "$fleet_file" ] || printf 'apiVersion: a12s.ai/v1alpha1\nkind: Fleet\nmetadata: { name: studio }\n' >"$fleet_file"
  echo "Starting the a12s Fleet \"studio\" (first run only)…"
  a12s -F "$fleet_file" up
fi

credentials=$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  fetch(`http://127.0.0.1:${c.port}/v1/credentials`, { headers: { authorization: `Bearer ${c.token}` } })
    .then((r) => r.text()).then((t) => process.stdout.write(t), () => process.stdout.write("unreachable"));
' "$HOME/.a12s/studio/controller.json")
case $credentials in
  *'"anthropic"'*) ;;
  *) echo "No Claude credential yet. Set one (see a12s's Setup for the token):"
     echo "  claude setup-token"
     printf '  pbpaste | tr -d %s | a12s -F "%s" creds set anthropic\n' "' \\n'" "$fleet_file" ;;
esac

if [ -n "$owner_login" ] || [ ! -f "$home/config.json" ]; then
  if [ -z "$owner_login" ]; then
    printf 'Your Tailscale login (the email you sign in to Tailscale with): '
    read -r owner_login
  fi
  [ -n "$owner_login" ] || die "An owner login is needed."
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ ownerLogin: process.argv[2], fleet: "studio" }, null, 2) + "\n", { mode: 0o600 })' \
    "$home/config.json" "$owner_login"
fi

[ -d "$repo/node_modules" ] || (cd "$repo" && npm ci --no-audit --no-fund)
(cd "$repo" && npm run build --silent >/dev/null)

mkdir -p "$logs" "$agents"
for template in "$repo"/launchd/*.plist; do
  name=$(basename "$template" .plist)
  label=com.a12s-studio.$name
  sed -e "s|{{node}}|$node|g" -e "s|{{repo}}|$repo|g" -e "s|{{home}}|$home|g" -e "s|{{logs}}|$logs|g" \
    "$template" >"$agents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$agents/$label.plist"
  echo "Started $label (log: $logs/$name.log)."
done

echo "Studio is at http://127.0.0.1:7400. To reach it from your other devices:"
echo "  tailscale serve --bg 7400"
