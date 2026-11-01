# Compile le moteur audio en un seul exécutable autonome : rien à installer sur le PC de l'utilisateur.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "native\publish"

dotnet publish (Join-Path $root "native\SpokaAudio\SpokaAudio.csproj") `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:PublishTrimmed=true `
  -p:TrimMode=partial `
  -p:DebugType=none `
  -o $out `
  -v q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# La capture de jeu : une petite DLL en C++, sans dépendance, chargée dans le jeu sur demande.
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "Compilateur C++ introuvable : installe les outils Visual C++." }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
$hook = Join-Path $root "native\SpokaHook\SpokaHook.cpp"
$objects = Join-Path $root "native\SpokaHook\obj"
New-Item -ItemType Directory -Force $objects | Out-Null
# Sans kit Windows installé, SPOKA_WINSDK désigne une copie dépliée des paquets Microsoft.Windows.SDK.CPP.
$sdk = ""
if ($env:SPOKA_WINSDK) {
  $include = (Get-ChildItem (Join-Path $env:SPOKA_WINSDK "cpp\c\Include") | Select-Object -First 1).FullName
  $libs = Join-Path $env:SPOKA_WINSDK "x64\c"
  $tools = (Get-ChildItem (Join-Path $vs "VC\Tools\MSVC") | Sort-Object Name | Select-Object -Last 1).FullName
  $sdk = "&& set `"INCLUDE=$tools\include;$include\um;$include\shared;$include\ucrt`" && set `"LIB=$tools\lib\x64;$libs\um\x64;$libs\ucrt\x64`""
}
cmd /c "`"$vcvars`" >nul $sdk && cl /nologo /LD /O2 /MT /W3 /EHsc /DUNICODE /D_UNICODE /Fo`"$objects\\`" `"$hook`" opengl32.lib gdi32.lib user32.lib kernel32.lib /link /OUT:`"$out\SpokaHook.dll`" /IMPLIB:`"$objects\SpokaHook.lib`""
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Get-Item (Join-Path $out "SpokaAudio.exe")
Write-Host ("Moteur audio : {0} ({1:N1} Mo)" -f $exe.FullName, ($exe.Length / 1MB))
