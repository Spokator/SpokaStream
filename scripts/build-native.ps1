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

$exe = Get-Item (Join-Path $out "SpokaAudio.exe")
Write-Host ("Moteur audio : {0} ({1:N1} Mo)" -f $exe.FullName, ($exe.Length / 1MB))
