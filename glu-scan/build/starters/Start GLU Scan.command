#!/bin/bash
# Dubbelklik dit bestand om de privacyscan te starten.
# Het opent een venster in je browser waar je bestanden in kunt slepen.
cd "$(dirname "$0")" || exit 1
./glu-scan ui
