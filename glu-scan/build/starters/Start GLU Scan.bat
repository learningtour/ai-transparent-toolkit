@echo off
REM Dubbelklik dit bestand om de privacyscan te starten.
REM Het opent een venster in je browser waar je bestanden in kunt slepen.
cd /d "%~dp0"
glu-scan.exe ui
