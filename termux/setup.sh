#!/data/data/com.termux/files/usr/bin/bash
#
# Nova Termux — one-shot setup on an Android phone.
#
#   bash termux/setup.sh
#
# It only installs what the app actually needs. Nothing here touches the
# network except `pkg`, and nothing is downloaded at runtime afterwards.
set -euo pipefail

echo "==> Nova Termux setup"

if ! command -v python >/dev/null 2>&1; then
  echo "==> installing python"
  pkg update -y
  pkg install -y python
else
  echo "==> python already present: $(python --version 2>&1)"
fi

if command -v termux-location >/dev/null 2>&1; then
  echo "==> termux-api already installed"
else
  echo "==> installing termux-api"
  pkg install -y termux-api || {
    echo "!! could not install termux-api."
    echo "!! The app still runs, but GPS will be unavailable."
  }
fi

# Storage access is only needed if the user wants to read files outside the
# project folder; the app itself never leaves it.
if command -v termux-setup-storage >/dev/null 2>&1 && [ ! -d "$HOME/storage" ]; then
  echo "==> optional: run 'termux-setup-storage' if you want shared-storage access"
fi

echo
echo "==> checking the app"
python -m unittest discover -s tests -t . 2>&1 | tail -5 || true

cat <<'DONE'

==> Done. Next steps:

  1. Install the "Termux:API" app from F-Droid.
     The Google Play build does not match current Termux and will not work.

  2. Grant the Location permission to BOTH Termux and Termux:API,
     and turn on the phone's GPS.

  3. Start the app:

       python main.py

     then open http://127.0.0.1:8000/ in the phone browser
     (Termux has a built-in browser shortcut, or use Chrome/Firefox).

  Useful commands:
    python main.py --status          # what is available right now
    python main.py --ask "کجام؟"     # one-shot question
    python main.py --repl            # chat in the terminal
    python main.py --selftest        # run the test suite
    python main.py --port 8080       # different port
    python main.py --host 0.0.0.0    # also reachable from other devices

DONE
