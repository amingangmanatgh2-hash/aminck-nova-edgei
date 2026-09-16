#!/usr/bin/env python3
"""
Nova — اجرا. هر آرگومانی جز `--open` مستقیم به `main.py` پاس داده می‌شود.

    python3 run.py                     سرور روی پورت ۸۰۰۰
    python3 run.py --open              اجرا + باز کردن مرورگر
    python3 run.py --port 8080
    python3 run.py --host 0.0.0.0
    python3 run.py --ask "کجام؟"
    python3 run.py --repl
    python3 run.py --status
    python3 run.py --selftest

فقط کتابخانه‌ی استاندارد. اگر پایتون ۳.۹+ نداری، اول `python3 setup.py`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

MIN_PYTHON = (3, 9)


def die(message: str, code: int = 1) -> "NoReturn":  # type: ignore[name-defined]
    print(f"\033[1;31m  xx\033[0m {message}", file=sys.stderr)
    raise SystemExit(code)


def check_interpreter() -> None:
    if sys.version_info < MIN_PYTHON:
        current = ".".join(str(p) for p in sys.version_info[:3])
        die(
            f"پایتون {current} پیدا شد ولی حداقل ۳.۹ لازم است.\n"
            f"     در ترموکس:  pkg install python"
        )


def split_flags(argv: list[str]) -> tuple[bool, list[str]]:
    """Peel off the flags run.py owns; everything else belongs to main.py."""
    open_browser = False
    rest: list[str] = []
    for arg in argv:
        if arg == "--open":
            open_browser = True
        else:
            rest.append(arg)
    return open_browser, rest


def read_option(argv: list[str], flag: str, default: str) -> str:
    """Read `--flag value` or `--flag=value` out of the passthrough args."""
    for index, arg in enumerate(argv):
        if arg.startswith(f"{flag}="):
            return arg.split("=", 1)[1]
        if arg == flag and index + 1 < len(argv):
            return argv[index + 1]
    return default


def open_url_later(url: str, delay: float = 2.0) -> str:
    """
    Schedule the browser to open once the server is up.

    Returns the name of the tool being used, so the message is honest about
    what actually happened. Runs in a daemon thread: the server itself is what
    keeps the process alive.
    """
    tool = None
    for candidate in ("termux-open-url", "termux-open", "xdg-open", "open"):
        if shutil.which(candidate):
            tool = candidate
            break

    def _go() -> None:
        time.sleep(delay)
        try:
            if tool:
                subprocess.run([tool, url], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                import webbrowser

                webbrowser.open(url)
        except Exception:  # noqa: BLE001 - opening a browser is best-effort
            pass

    threading.Thread(target=_go, name="open-browser", daemon=True).start()
    return tool or "webbrowser"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        print(
            "\nپرچم‌های خودِ run.py:\n"
            "  --open        بعد از بالا آمدن سرور، مرورگر را باز کن\n"
            "  --no-banner   بنر چاپ نشود\n"
            "\nبقیه‌ی پرچم‌ها به main.py می‌روند؛ فهرست کامل:\n"
            "  python3 main.py --help"
        )
        return 0

    check_interpreter()

    open_browser, rest = split_flags(argv)
    no_banner = "--no-banner" in rest
    if no_banner:
        rest.remove("--no-banner")

    host = read_option(rest, "--host", "127.0.0.1")
    port = read_option(rest, "--port", "8000")
    url_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    url = f"http://{url_host}:{port}/"

    # Only the long-running server is worth auto-opening a browser for.
    server_mode = not any(
        a in rest for a in ("--ask", "--repl", "--status", "--selftest")
    )
    if open_browser and server_mode:
        tool = open_url_later(url)
        print(f"  مرورگر با «{tool}» باز می‌شود: {url}")

    if not no_banner and server_mode:
        print(f"\n  \033[1mNova\033[0m  —  {url}  —  Ctrl-C برای توقف\n")

    # Import late so --help stays instant and errors above are readable.
    import main as entrypoint

    return entrypoint.main(rest)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
