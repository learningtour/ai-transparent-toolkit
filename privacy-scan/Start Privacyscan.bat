@echo off
REM Dubbelklik dit bestand om de privacyscan te starten (Windows).
REM Er opent een venster in je browser waar je bestanden in kunt slepen.
cd /d "%~dp0"

where py >nul 2>&1 && goto :startmetpy
where python >nul 2>&1 && goto :startmetpython

echo.
echo Python 3 is nog niet geinstalleerd.
echo Haal het gratis op bij https://www.python.org/downloads/ en probeer het opnieuw.
echo Zet bij het installeren een vinkje bij "Add python.exe to PATH".
echo.
pause
exit /b 1

:startmetpy
py -3 privacy_scan.py ui
goto :einde

:startmetpython
python privacy_scan.py ui

:einde
if errorlevel 1 pause
