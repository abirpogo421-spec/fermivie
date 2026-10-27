@echo off
rem Windows: double-click to start Fermivie. Keep the window that opens; close it to stop.
pushd "%~dp0"
if not exist "launch.py" (
  echo Unzip the whole Fermivie folder first: right-click the zip, choose Extract All,
  echo then double-click this file inside the new folder.
  goto done
)
set "PMPY="
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PMPY=py -3"
if not defined PMPY (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PMPY=python"
)
if not defined PMPY (
  echo Python 3 isn't installed. Get it from https://www.python.org/downloads/
  echo In the installer, tick "Add python.exe to PATH". Then double-click this file again.
  goto done
)
%PMPY% launch.py
if errorlevel 3 if not errorlevel 4 (
  timeout /t 3 >nul
  popd
  exit /b 0
)
:done
echo.
pause
popd
