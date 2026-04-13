@echo off
chcp 65001 >nul
title Gerar APK - Sculacho.com
cd /d "%~dp0"

set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.10.7-hotspot"
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "ANDROID_SDK_ROOT=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"

if not exist "%JAVA_HOME%\bin\java.exe" (
  echo JDK 21 nao encontrado em:
  echo %JAVA_HOME%
  echo.
  echo Instale o Eclipse Temurin JDK 21 e tente novamente.
  pause
  exit /b 1
)

if not exist "%ANDROID_HOME%" (
  echo Android SDK nao encontrado em:
  echo %ANDROID_HOME%
  echo.
  echo Instale o Android Studio/SDK e tente novamente.
  pause
  exit /b 1
)

echo Gerando build web...
call npm run build
if errorlevel 1 goto erro

echo.
echo Sincronizando Android...
call npx cap sync android
if errorlevel 1 goto erro

echo.
echo Gerando APK debug...
cd /d "%~dp0android"
call gradlew.bat assembleDebug
if errorlevel 1 goto erro

cd /d "%~dp0"
copy /Y "android\app\build\outputs\apk\debug\app-debug.apk" "Sculacho-teste.apk" >nul

echo.
echo APK pronto:
echo %CD%\Sculacho-teste.apk
echo.
echo Pode enviar esse arquivo para teste em um celular Android.
pause
exit /b 0

:erro
echo.
echo Erro ao gerar o APK.
pause
exit /b 1
