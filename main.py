#!/usr/bin/env python3
"""
Nova Termux — everything in this folder, served on localhost.

    python3 main.py                 # start the web app on http://127.0.0.1:8000
    python3 main.py --port 9000     # different port
    python3 main.py --host 0.0.0.0  # also reachable from other devices on the LAN
    python3 main.py --ask "کجام؟"   # one-shot question, no server
    python3 main.py --repl          # chat in the terminal
    python3 main.py --status        # diagnostics, then exit
    python3 main.py --selftest      # run the test suite and exit

No third-party packages, no network access. Python 3.9+ and the standard
library are enough, which is why this runs on Termux as-is.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from termuxapp import __version__  # noqa: E402
from termuxapp.assistant import Assistant  # noqa: E402
from termuxapp.gps import GpsProvider  # noqa: E402
from termuxapp.paths import ensure_dirs  # noqa: E402
from termuxapp.server import Application, create_server, lan_addresses  # noqa: E402

BANNER = r"""
  ╔═══════════════════════════════════════════════════════════╗
  ║  NOVA TERMUX — دستیار آفلاین مکان و سرور                  ║
  ║  همه‌چیز از همین پوشه خوانده می‌شود. بدون اینترنت.        ║
  ╚═══════════════════════════════════════════════════════════╝
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py",
        description="Localhost app that reads everything from this folder.",
    )
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind address (default 127.0.0.1; use 0.0.0.0 for LAN)")
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    parser.add_argument("--ask", metavar="TEXT", help="ask one question and exit")
    parser.add_argument("--repl", action="store_true", help="chat in the terminal")
    parser.add_argument("--status", action="store_true", help="print diagnostics and exit")
    parser.add_argument("--selftest", action="store_true", help="run the test suite and exit")
    parser.add_argument("--watch", action="store_true",
                        help="keep GPS refreshed in the background while serving")
    parser.add_argument("--reset-memory", action="store_true",
                        help="clear the dialogue memory (saved places are kept)")
    parser.add_argument("--quiet", action="store_true", help="less output")
    return parser


def print_status(app: Application) -> None:
    import json

    status = app.status()
    print(json.dumps(status, ensure_ascii=False, indent=2))
    gps = status["gps"]
    print()
    if gps["termux_api_installed"]:
        print("✓ Termux:API نصب است — جی‌پی‌اس در دسترس است.")
    else:
        print("✗ Termux:API نصب نیست. جی‌پی‌اس کار نمی‌کند تا وقتی:")
        print(gps["hint_fa"])
    print()
    if gps["cached_fix"]:
        fix = gps["cached_fix"]
        print(f"آخرین موقعیت کش‌شده: {fix['lat']}, {fix['lon']} ({fix.get('age_fa', '?')})")
    else:
        print("موقعیت کش‌شده‌ای وجود ندارد.")
    print(f"مکان‌های ذخیره‌شده: {status['places_count']}")
    print(f"مدخل‌های پایگاه دانش: {status['knowledge_entries']}")
    print(f"محصولات کاتالوگ: {status['catalog_products']}")


def run_repl(assistant: Assistant) -> None:
    print("حالت گفتگو. برای خروج: exit یا Ctrl-D")
    while True:
        try:
            text = input("\nتو > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if text.lower() in ("exit", "quit", "خروج"):
            return
        if not text:
            continue
        reply = assistant.ask(text)
        print(f"\nدستیار > {reply.text}")
        if reply.suggestions:
            print("\nپیشنهاد: " + " | ".join(reply.suggestions))
        print(f"[نیت: {reply.intent} • اطمینان: {reply.confidence:.2f}]")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ensure_dirs()

    if args.selftest:
        import unittest

        suite = unittest.defaultTestLoader.discover("tests", top_level_dir=str(Path(__file__).parent))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1

    if args.ask:
        assistant = Assistant()
        reply = assistant.ask(args.ask)
        print(reply.text)
        print(f"\n[nit={reply.intent} confidence={reply.confidence:.2f} kind={reply.kind}]",
              file=sys.stderr)
        return 0

    app = Application()

    if args.reset_memory:
        app.assistant.reset()
        print("حافظه‌ی گفتگو پاک شد (مکان‌های ذخیره‌شده دست‌نخورده‌اند).")

    if args.status:
        print_status(app)
        return 0

    if args.repl:
        run_repl(app.assistant)
        return 0

    if args.watch:
        if app.gps.start_watch():
            print("پایش زنده‌ی جی‌پی‌اس فعال شد.")
        else:
            print("پایش زنده ممکن نیست: Termux:API نصب نیست.")

    try:
        httpd = create_server(args.host, args.port, app)
    except PermissionError:
        print(f"اجازه ندارم روی پورت {args.port} گوش دهم.", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"نشد سرور را روی {args.host}:{args.port} بالا بیاورم: {exc}", file=sys.stderr)
        if "Address already in use" in str(exc):
            print("احتمالاً یک نمونه‌ی دیگر در حال اجراست؛ پورت دیگری بده: --port 8080")
        return 1

    host_for_url = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host
    print(BANNER)
    print(f"  نسخه {__version__}   پایتون {sys.version.split()[0]}")
    print(f"  پوشه: {Path(__file__).resolve().parent}")
    print()
    print(f"  🌐  http://{host_for_url}:{args.port}/          ← اینجا را در مرورگر باز کن")
    if args.host in ("0.0.0.0", "::"):
        for addr in lan_addresses():
            print(f"  📱  http://{addr}:{args.port}/   ← از گوشی دیگر در همان وای‌فای")
    print(f"  📁  http://{host_for_url}:{args.port}/fs/       ← مرورگر فایل‌ها")
    print(f"  📚  http://{host_for_url}:{args.port}/docs/     ← مستندات")
    print()
    gps = app.gps.status()
    if gps["termux_api_installed"]:
        print("  ✓ جی‌پی‌اس: Termux:API نصب است")
    else:
        print("  ⚠ جی‌پی‌اس: Termux:API نصب نیست — دستور «وضعیت جی‌پی‌اس» راهنمایی می‌کند")
    print(f"  ✓ مکان‌های ذخیره‌شده: {app.status()['places_count']}")
    print(f"  ✓ پایگاه دانش: {app.status()['knowledge_entries']} مدخل")
    print()
    print("  برای توقف: Ctrl-C")
    print()

    try:
        httpd.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\nدر حال بستن…")
    finally:
        app.gps.stop_watch()
        httpd.shutdown()
        httpd.server_close()
        print(f"بسته شد در {time.strftime('%H:%M:%S')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
