@echo off
REM Build linkspace-rootdev.exe (Line 3, device-node helper).
REM Toolchain: EWDK 28000.2526 (D:\dev\iddcx\EWDK_28000.2526.iso, must be mounted first).
REM   Mount: powershell Mount-DiskImage -ImagePath D:\dev\iddcx\EWDK_28000.2526.iso
REM   The mounted drive letter may not be E: - pass it as an argument: build.cmd F:
REM   Dismount the ISO when done: Dismount-DiskImage -ImagePath D:\dev\iddcx\EWDK_28000.2526.iso
REM Usage: build.cmd [EWDK drive letter], default E:.
REM Output (in this directory):
REM   linkspace-rootdev.exe (/MT static CRT, no VC runtime needed on target machines)
REM   linkspace-rootdev.obj (intermediate, git-ignored)
REM Copy the exe to apps\desktop\resources\winhelper\linkspace-rootdev.exe
REM for distribution, and update the SHA-256 in that directory's README.md.
REM NOTE: this file is ASCII-only on purpose - cmd.exe misparses UTF-8
REM Chinese comments (codepage 936 byte misalignment). Keep the Chinese
REM explanation in README.md next to it.
REM NOTE: SetupBuildEnv calls vsdevcmd with -winsdk=none, so the Windows
REM SDK include/lib paths are NOT on INCLUDE/LIB; add them here from
REM %WindowsSdkDir% / %Version_Number% (set by SetupBuildEnv.cmd).
setlocal
set "EWDK=%~1"
if "%EWDK%"=="" set "EWDK=E:"
if not exist "%EWDK%\BuildEnv\SetupBuildEnv.cmd" (
  echo EWDK not mounted or wrong drive letter: %EWDK%\BuildEnv\SetupBuildEnv.cmd not found
  echo Mount first: powershell Mount-DiskImage -ImagePath D:\dev\iddcx\EWDK_28000.2526.iso
  exit /b 1
)
call "%EWDK%\BuildEnv\SetupBuildEnv.cmd" amd64
if errorlevel 1 exit /b 1
set "INCLUDE=%INCLUDE%;%WindowsSdkDir%Include\%Version_Number%\um;%WindowsSdkDir%Include\%Version_Number%\shared;%WindowsSdkDir%Include\%Version_Number%\winrt;%WindowsSdkDir%Include\%Version_Number%\ucrt"
set "LIB=%LIB%;%WindowsSdkDir%Lib\%Version_Number%\um\x64;%WindowsSdkDir%Lib\%Version_Number%\ucrt\x64"
cl /nologo /MT /O2 /W4 /DUNICODE /D_UNICODE /EHsc linkspace-rootdev.cpp /link setupapi.lib newdev.lib /OUT:linkspace-rootdev.exe
if errorlevel 1 exit /b 1
echo.
echo Build OK: linkspace-rootdev.exe
dir linkspace-rootdev.exe
