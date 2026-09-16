#!/usr/bin/env python3
"""
Nova — ستاپ و بررسی محیط. فقط کتابخانه‌ی استاندارد پایتون.

    python3 setup.py              نصب چیزهای لازم + اجرای تست‌ها
    python3 setup.py --no-test    بدون اجرای تست‌ها
    python3 setup.py --yes        پرسش‌ها را با «بله» جواب بده
    python3 setup.py --check      فقط بررسی کن، چیزی نصب نکن

این فایل یک `setup.py` از نوع setuptools **نیست**؛ یک CLI ساده است.
هیچ بسته‌ی پایتونی نصب نمی‌کند، چون برنامه هیچ وابستگی‌ای ندارد. تنها چیزی
که ممکن است نصب کند `termux-api` است (با `pkg`) تا جی‌پی‌اس کار کند.
"""

from __future__ import annotations

import argparse
import importlib
import os
import platform
import shutil
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# ----------------------------------------------------------------- output

USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text


def step(msg: str) -> None:
    print(f"\n{_c('1;32', '==>')} {msg}")


def ok(msg: str) -> None:
    print(f"  {_c('32', 'ok')} {msg}")


def warn(msg: str) -> None:
    print(f"  {_c('1;33', '!!')} {msg}")


def fail(msg: str) -> None:
    print(f"  {_c('1;31', 'xx')} {msg}")


def run(argv: list[str], timeout: float = 600) -> tuple[int, str]:
    """Run a command, streaming nothing, returning (code, combined output)."""
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False,
        )
    except FileNotFoundError:
        return 127, f"command not found: {argv[0]}"
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    except OSError as exc:  # pragma: no cover - platform specific
        return 1, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


# ------------------------------------------------------------- environment

def is_termux() -> bool:
    if "com.termux" in os.environ.get("PREFIX", ""):
        return True
    if "com.termux" in os.environ.get("HOME", ""):
        return True
    if Path("/data/data/com.termux").is_dir():
        return True
    return platform.system() == "Android"


def pkg_manager() -> str | None:
    for name in ("pkg", "apt-get", "dnf", "pacman"):
        if shutil.which(name):
            return name
    return None


# ------------------------------------------------------------------ checks

REQUIRED_MODULES = (
    "sqlite3", "http.server", "socketserver", "json", "unicodedata",
    "difflib", "argparse", "subprocess", "threading", "re", "math",
    "hashlib", "hmac", "shutil", "tempfile",
)

REQUIRED_FILES = (
    "main.py",
    "termuxapp/server.py",
    "termuxapp/assistant.py",
    "termuxapp/gps.py",
    "termuxapp/places.py",
    "web/index.html",
    "web/app.css",
    "web/app.js",
    "data/catalog.json",
)


def check_python() -> bool:
    step("پایتون")
    version = sys.version_info
    text = f"{version.major}.{version.minor}.{version.micro} ({platform.python_implementation()})"
    if version < (3, 9):
        fail(f"پایتون {text} — حداقل ۳.۹ لازم است.")
        return False
    ok(f"پایتون {text}")
    return True


def check_stdlib() -> bool:
    step("کتابخانه‌های استاندارد")
    missing = []
    for name in REQUIRED_MODULES:
        try:
            importlib.import_module(name)
        except ImportError:
            missing.append(name)
    if missing:
        fail("پایتون ناقص نصب شده، این‌ها نیستند: " + ", ".join(missing))
        warn("در ترموکس: pkg install python را دوباره بزن.")
        return False
    ok(f"همه‌ی {len(REQUIRED_MODULES)} ماژول لازم موجودند")
    version = __import__("sqlite3").sqlite_version
    ok(f"SQLite {version}")
    return True


def check_files() -> bool:
    step("فایل‌های پروژه")
    missing = [f for f in REQUIRED_FILES if not (ROOT / f).is_file()]
    if missing:
        fail("اینها نیستند: " + ", ".join(missing))
        return False
    ok(f"همه‌ی {len(REQUIRED_FILES)} فایل لازم موجودند")
    kb = sorted((ROOT / "data/knowledge").glob("*.json"))
    if not kb:
        warn("data/knowledge خالی است — دستیار چیزی برای جواب دادن ندارد.")
    else:
        ok(f"{len(kb)} فایل پایگاه دانش")
    return True


def check_writable() -> bool:
    step("دسترسی نوشتن")
    target = ROOT / "data"
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        fail(f"نمی‌توانم داخل {target} بنویسم: {exc}")
        return False
    ok(f"{target} قابل نوشتن است")
    return True


def check_termux_api(assume_yes: bool, install: bool) -> bool:
    """
    GPS readiness. Returns True if termux-location is callable.

    Outside Termux this is expected to be False and is reported as such —
    it is not an error, the app still runs with manual coordinates.
    """
    step("جی‌پی‌اس / Termux:API")
    if shutil.which("termux-location"):
        ok("termux-location پیدا شد — جی‌پی‌اس در دسترس است")
        if shutil.which("termux-battery-status"):
            ok("termux-battery-status هم هست")
        return True

    if not is_termux():
        warn("این محیط ترموکس نیست، پس جی‌پی‌اس سخت‌افزاری وجود ندارد.")
        warn("برنامه کار می‌کند؛ مختصات را می‌توانی دستی وارد کنی.")
        return False

    warn("termux-location پیدا نشد — جی‌پی‌اس کار نمی‌کند.")
    print("    برای فعال کردنش سه چیز لازم است:")
    print("    ۱) اپ «Termux:API» از F-Droid (نسخه‌ی گوگل‌پلی کار نمی‌کند)")
    print("    ۲) pkg install termux-api")
    print("    ۳) اجازه‌ی Location به هر دو برنامه + روشن بودن جی‌پی‌اس گوشی")

    if not install:
        return False
    if shutil.which("pkg") is None:
        fail("pkg پیدا نشد، نمی‌توانم خودکار نصب کنم.")
        return False
    if not assume_yes:
        answer = input("    حالا نصبش کنم؟ [y/N] ").strip().lower()
        if answer not in ("y", "yes", "بله", "b"):
            warn("رد شد. بعداً می‌توانی دستی: pkg install termux-api")
            return False

    print("    در حال نصب termux-api …")
    code, out = run(["pkg", "install", "-y", "termux-api"], timeout=900)
    if code == 0 and shutil.which("termux-location"):
        ok("termux-api نصب شد")
        return True
    fail(f"نصب ناموفق (کد {code}).")
    for line in out.strip().splitlines()[-8:]:
        print(f"      {line}")
    return False


def run_tests() -> bool:
    step("اجرای تست‌ها")
    started = time.time()
    loader = unittest.defaultTestLoader
    try:
        suite = loader.discover("tests", top_level_dir=str(ROOT))
    except Exception as exc:  # pragma: no cover - broken test tree
        fail(f"کشف تست‌ها ناموفق: {exc}")
        return False
    result = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(suite)
    elapsed = time.time() - started
    summary = (
        f"{result.testsRun} تست در {elapsed:.1f} ثانیه — "
        f"{len(result.failures)} شکست، {len(result.errors)} خطا، "
        f"{len(result.skipped)} ردشده"
    )
    if result.wasSuccessful():
        ok(summary)
        if result.skipped:
            warn("تست‌های ردشده معمولاً یعنی ابزار سمت تایپ‌اسکریپت نصب نیست؛"
                 " برای بخش پایتون مهم نیست.")
        return True
    fail(summary)
    return False


# ------------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="setup.py",
        description="ستاپ و بررسی محیط Nova (فقط پایتون استاندارد)",
    )
    parser.add_argument("--no-test", action="store_true", help="تست‌ها اجرا نشوند")
    parser.add_argument("--check", action="store_true",
                        help="فقط بررسی کن؛ چیزی نصب نکن")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="پرسش‌ها را با بله جواب بده")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    print(_c("1", "\nNova — ستاپ"))
    print(f"  پوشه: {ROOT}")
    print(f"  سیستم: {platform.system()} {platform.release()}"
          f"{' (ترموکس)' if is_termux() else ''}")

    problems: list[str] = []
    if not check_python():
        return 1
    if not check_stdlib():
        problems.append("کتابخانه‌های استاندارد")
    if not check_files():
        problems.append("فایل‌های پروژه")
    if not check_writable():
        problems.append("دسترسی نوشتن")

    gps_ready = check_termux_api(
        assume_yes=args.yes, install=not args.check,
    )

    tests_ok = True
    if not args.no_test and not problems:
        tests_ok = run_tests()
    elif problems:
        warn("به‌خاطر مشکل‌های بالا تست‌ها اجرا نشد.")

    # ------------------------------------------------------------- summary
    step("جمع‌بندی")
    if problems:
        for item in problems:
            fail(item)
        return 1
    if not tests_ok:
        fail("تست‌ها پاس نشدند.")
        return 1

    ok("همه‌چیز آماده است.")
    if gps_ready:
        ok("جی‌پی‌اس آماده است.")
    else:
        warn("جی‌پی‌اس آماده نیست — مختصات دستی کار می‌کند.")

    print(f"""
  اجرا:
      python3 run.py                  →  http://127.0.0.1:8000/
      python3 run.py --open           →  اجرا + باز کردن مرورگر
      python3 run.py --port 8080
      python3 run.py --host 0.0.0.0   →  از گوشی دیگر در همان وای‌فای

  بدون سرور:
      python3 run.py --status
      python3 run.py --ask "کجام؟"
      python3 run.py --repl
      python3 run.py --selftest
""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
