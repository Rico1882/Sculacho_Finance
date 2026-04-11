@echo off
chcp 65001 >nul
title Sculacho — ZIP para alojamento
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Instala Node.js a partir de https://nodejs.org
  pause
  exit /b 1
)

echo A compilar e criar dist.zip...
call npm run build:zip
if errorlevel 1 (
  echo Erro ao criar o ZIP.
  pause
  exit /b 1
)

echo.
echo Concluido: dist.zip na pasta do projeto.
if exist "%~dp0dist.zip" explorer /select,"%~dp0dist.zip"
pause
