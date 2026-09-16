#!/usr/bin/env bash
#
# Nova — setup کلی. روی ترموکس (اندروید) و لینوکس کار می‌کند.
#
#   bash setup.sh              نصب و بررسی
#   bash setup.sh --no-test    بدون اجرای تست‌ها
#
# این اسکریپت فقط چیزی را نصب می‌کند که واقعاً لازم است. بعد از اتمام،
# برنامه هیچ درخواست شبکه‌ای نمی‌زند.
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_TESTS=1
for arg in "$@"; do
  [ "$arg" = "--no-test" ] && RUN_TESTS=0
done

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m  xx\033[0m %s\n' "$1" >&2; exit 1; }

# ------------------------------------------------------------- environment

IS_TERMUX=0
case "${PREFIX:-}" in
  *com.termux*) IS_TERMUX=1 ;;
esac
if [ -d /data/data/com.termux ]; then IS_TERMUX=1; fi
if [ "$(uname -o 2>/dev/null || echo)" = "Android" ]; then IS_TERMUX=1; fi

if [ "$IS_TERMUX" = "1" ]; then
  say "ترموکس تشخیص داده شد"
else
  say "محیط غیر ترموکس (لینوکس/مک) — فقط پایتون لازم است"
fi

# ------------------------------------------------------------------ python

pick_python() {
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
        printf '%s' "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON="$(pick_python || true)"

if [ -z "$PYTHON" ]; then
  say "نصب پایتون"
  if [ "$IS_TERMUX" = "1" ]; then
    pkg update -y
    pkg install -y python
  else
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y python3
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y python3
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -S --noconfirm python
    elif command -v brew >/dev/null 2>&1; then
      brew install python3
    else
      die "پایتون پیدا نشد و مدیر بسته‌ی شناخته‌شده‌ای هم نیست. دستی نصبش کن."
    fi
  fi
  PYTHON="$(pick_python || true)"
fi

[ -n "$PYTHON" ] || die "پایتون ۳.۹+ نصب نشد."
say "پایتون: $("$PYTHON" --version 2>&1)"

# کتابخانه‌های استاندارد لازم — اگر یکی نباشد یعنی پایتون ناقص نصب شده
say "بررسی کتابخانه‌های استاندارد"
"$PYTHON" - <<'PY'
import importlib, sys
missing = []
for mod in ("sqlite3", "http.server", "json", "unicodedata", "difflib",
            "argparse", "socketserver", "subprocess", "threading"):
    try:
        importlib.import_module(mod)
    except ImportError:
        missing.append(mod)
if missing:
    print("  xx پایتون ناقص نصب شده، این‌ها نیستند: " + ", ".join(missing))
    sys.exit(1)
print("  ok همه‌ی ماژول‌های لازم موجودند")
PY

# -------------------------------------------------------------- termux-api

if [ "$IS_TERMUX" = "1" ]; then
  if command -v termux-location >/dev/null 2>&1; then
    say "termux-api نصب است — جی‌پی‌اس در دسترس است"
  else
    say "نصب termux-api (برای جی‌پی‌اس)"
    if pkg install -y termux-api; then
      echo "  ok نصب شد"
    else
      warn "نصب termux-api ناموفق بود. برنامه کار می‌کند ولی جی‌پی‌اس ندارد."
    fi
  fi
fi

# -------------------------------------------------------------- permissions

chmod +x run.sh setup.sh 2>/dev/null || true

# ------------------------------------------------------------------- tests

if [ "$RUN_TESTS" = "1" ]; then
  say "اجرای تست‌ها"
  # pipefail is on, so the pipeline's status is unittest's, not tail's.
  # Show enough of the tail that a real failure is actually readable.
  if "$PYTHON" -m unittest discover -s tests -t . 2>&1 | grep -v '^\[[0-9]' | tail -25; then
    echo "  ok همه‌ی تست‌ها پاس شدند"
  else
    warn "تعدادی تست رد شد — خروجی بالا را بخوان."
  fi
fi

# ------------------------------------------------------------------ summary

cat <<'DONE'


================================================================
  نصب تمام شد.
================================================================

  اجرا:
      bash run.sh                 →  http://127.0.0.1:8000/
      bash run.sh --open          →  اجرا + باز کردن مرورگر (ترموکس)
      bash run.sh --port 8080     →  پورت دیگر
      bash run.sh --host 0.0.0.0  →  از گوشی دیگر در همان وای‌فای هم برسد

  بدون سرور:
      bash run.sh --status        →  چه چیزی الان در دسترس است
      bash run.sh --ask "کجام؟"
      bash run.sh --repl          →  گفتگو در ترمینال
      bash run.sh --selftest      →  تست‌ها

اگر جی‌پی‌اس کار نکرد، سه چیز لازم است:
  1) اپ «Termux:API» از F-Droid   (نسخه‌ی گوگل‌پلی کار نمی‌کند)
  2) pkg install termux-api
  3) اجازه‌ی Location به هر دو برنامه + روشن بودن جی‌پی‌اس گوشی

DONE
