@echo off
setlocal

rem Always run from this script's own directory, so double-clicking it from
rem Explorer works the same as running it from a terminal already cd'd here.
cd /d "%~dp0"

echo SkyRoads HD
echo ===========
echo.

if not exist "node_modules\" (
    echo Installing dependencies, this only happens once...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. See the output above.
        pause
        exit /b 1
    )
    echo.
)

if not exist "assets\original\ROADS.LZS" (
    echo WARNING: assets\original\ROADS.LZS is missing.
    echo SkyRoads HD needs your own copy of the original game there.
    echo See README.md for where to get it and where to put it.
    echo The dev server will still start, but the game will fail to load.
    echo.
)

echo Starting the dev server...
echo Once it says "ready", open the Local URL it prints ^(usually http://localhost:5173^) in your browser.
echo Press Ctrl+C in this window to stop the server.
echo.

call npm run dev

pause
