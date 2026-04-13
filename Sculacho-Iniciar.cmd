@echo off
chcp 65001 >nul
title Sculacho.com
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Instala Node.js a partir de https://nodejs.org
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo A compilar o projeto ^(primeira vez ou apos alteracoes^)...
  call npm run build
  if errorlevel 1 (
    echo Erro na compilacao.
    pause
    exit /b 1
  )
)

echo.
echo Abrindo Sculacho em http://localhost:4173
echo Fecha esta janela para parar o aplicativo.
echo.
call npm run app
pause
