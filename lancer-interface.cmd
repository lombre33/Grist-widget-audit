@echo off
setlocal
rem Lanceur de l'interface web gwaudit (Windows) : double-clic, le navigateur s'ouvre tout seul.
rem Tout reste sur le disque de l'outil : rapports dans ce dossier, fichiers temporaires dans .tmp-travail.

if "%~1"=="--ouvrir" goto ouvrir

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto sansnode
if not exist "node_modules\acorn\package.json" goto sansdependances

if not exist ".tmp-travail" mkdir ".tmp-travail"
set "TEMP=%~dp0.tmp-travail"
set "TMP=%~dp0.tmp-travail"

echo Interface gwaudit : http://127.0.0.1:4317
echo Fermer cette fenetre (ou Ctrl+C) arrete le serveur.
echo.

start "" /b "%~f0" --ouvrir
node bin\gwaudit.js --interface

echo.
echo Le serveur s'est arrete.
pause
exit /b 0

:ouvrir
rem Attend que le serveur reponde (15 s au plus), puis ouvre le navigateur par defaut.
set /a essais=0
:attendre
curl -s -o nul "http://127.0.0.1:4317/" >nul 2>&1
if not errorlevel 1 goto navigateur
set /a essais+=1
if %essais% geq 15 goto navigateur
ping -n 2 127.0.0.1 >nul
goto attendre
:navigateur
start "" "http://127.0.0.1:4317"
exit /b 0

:sansnode
echo Node.js est introuvable : l'installer (version 20 ou plus) puis relancer.
pause
exit /b 1

:sansdependances
echo Les dependances ne sont pas installees : lancer d'abord  npm ci  dans ce dossier.
pause
exit /b 1
