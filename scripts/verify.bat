@echo off
REM scripts\verify.bat
REM Lo mismo que correra la CI: lint, typecheck, tests y build, en ese orden.
REM Se detiene en el primer paso que falle.
REM
REM Requisitos: Postgres del docker-compose de atencion-ia-database levantado
REM (los tests crean y borran su propia base "atencion_ia_test").
REM
REM Uso (desde la carpeta atencion-ia-backend, en cmd.exe):
REM     scripts\verify.bat

echo === 1/4 lint (eslint + prettier) ===
call npm run lint || goto :fallo
echo === 2/4 typecheck ===
call npm run typecheck || goto :fallo
echo === 3/4 tests ===
call npm test || goto :fallo
echo === 4/4 build ===
call npm run build || goto :fallo
echo.
echo Verificacion completa: todo en orden.
exit /b 0

:fallo
echo.
echo FALLO la verificacion (ver el paso de arriba).
exit /b 1
