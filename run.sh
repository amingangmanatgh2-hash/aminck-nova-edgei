#!/usr/bin/env bash
#
# Nova — اجرا. تمام آرگومان‌ها به main.py پاس داده می‌شوند.
#
#   bash run.sh                     سرور روی پورت ۸۰۰۰
#   bash run.sh --open              اجرا + باز کردن مرورگر (ترموکس)
#   bash run.sh --port 8080
#   bash run.sh --host 0.0.0.0
#   bash run.sh --ask "کجام؟"
#   bash run.sh --repl
#   bash run.sh --status
#   bash run.sh --selftest
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

warn() { printf '\033[1;33m  !!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31m  xx\033[0m %s\n' "$1" >&2; exit 1; }

# ------------------------------------------------------------- pick python

PYTHON=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  die "پایتون ۳.۹+ پیدا نشد. اول این را اجرا کن:  bash setup.sh"
fi

# ------------------------------------------------------- split our own flags

OPEN=0
ARGS=()
for arg in ${1+"$@"}; do
  case "$arg" in
    --open) OPEN=1 ;;
    -h|--help)
      sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) ARGS+=("$arg") ;;
  esac
done

# --------------------------------------------------- read port/host for URL

PORT=8000
HOST=127.0.0.1
prev=""
for arg in ${ARGS[@]+"${ARGS[@]}"}; do
  case "$arg" in
    --port=*) PORT="${arg#--port=}" ;;
    --host=*) HOST="${arg#--host=}" ;;
    *)
      [ "$prev" = "--port" ] && PORT="$arg"
      [ "$prev" = "--host" ] && HOST="$arg"
      ;;
  esac
  prev="$arg"
done

URL_HOST="$HOST"
case "$HOST" in 0.0.0.0|::|"") URL_HOST=127.0.0.1 ;; esac
URL="http://$URL_HOST:$PORT/"

# ------------------------------------------------------------- open browser

if [ "$OPEN" = "1" ]; then
  if command -v termux-open-url >/dev/null 2>&1; then
    ( sleep 2; termux-open-url "$URL" ) &
  elif command -v xdg-open >/dev/null 2>&1; then
    ( sleep 2; xdg-open "$URL" ) &
  else
    warn "ابزار باز کردن مرورگر پیدا نشد؛ خودت $URL را باز کن."
  fi
fi

# ------------------------------------------------------------------- launch

if [ ${#ARGS[@]} -eq 0 ]; then
  printf '\n  \033[1mNova\033[0m  —  %s  —  Ctrl-C برای توقف\n\n' "$URL"
fi

exec "$PYTHON" main.py ${ARGS[@]+"${ARGS[@]}"}
