@echo off
setlocal EnableDelayedExpansion
REM dd-capture build script - must run inside the EWDK build environment
REM (cl.exe comes from EWDK; this script sets INCLUDE/LIB itself because
REM SetupVSEnv leaves them empty - raw cl.exe has no MSBuild props).
REM
REM Usage on zero (E: is the mounted EWDK ISO):
REM   E:\BuildEnv\SetupBuildEnv.cmd
REM   call SetupVSEnv
REM   cd /d D:\test\testforai\LinkSpace\native\dd-capture
REM   build.cmd
REM
REM Output: x64\Release\dd-capture.exe (not committed, see .gitignore).
REM NOTE: LaunchBuildEnv.cmd is "%comspec% /k ..." and hangs waiting for
REM interaction - for non-interactive builds call SetupBuildEnv.cmd
REM directly (see native/virtual-display/README.md).
REM EWDK_ROOT may be set to the mounted ISO drive (default E:).
if "%EWDK_ROOT%"=="" set EWDK_ROOT=E:
set "MSVC=%EWDK_ROOT%\Program Files\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.50.35717"
set "SDK=%EWDK_ROOT%\Program Files\Windows Kits\10"
set "INCLUDE=%MSVC%\include;%SDK%\Include\10.0.28000.0\um;%SDK%\Include\10.0.28000.0\shared;%SDK%\Include\10.0.28000.0\ucrt;%SDK%\Include\10.0.28000.0\winrt"
set "PATH=%MSVC%\bin\Hostx64\x64;%PATH%"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\10.0.28000.0\um\x64;%SDK%\Lib\10.0.28000.0\ucrt\x64"
if not exist x64\Release mkdir x64\Release
cl /nologo /EHsc /O2 /W3 dd-capture.cpp /link d3d11.lib dxgi.lib /OUT:x64\Release\dd-capture.exe
if errorlevel 1 exit /b 1
echo [build] OK: x64\Release\dd-capture.exe
dir x64\Release\dd-capture.exe
