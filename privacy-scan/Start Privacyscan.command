#!/bin/bash
# Dubbelklik dit bestand om de privacyscan te starten (Mac).
# Er opent een venster in je browser waar je bestanden in kunt slepen.
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo
  echo "Python 3 is nog niet geïnstalleerd."
  echo "Haal het gratis op bij https://www.python.org/downloads/ en probeer het opnieuw."
  echo
  read -r -p "Druk op Enter om te sluiten."
  exit 1
fi

python3 privacy_scan.py ui
