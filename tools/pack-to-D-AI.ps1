# ============================================================================
#  Package the "dsh-plugin-prompt-optimizer" skill into D:\AI
#  and place the demo HTML next to it.
#
#  Why a script: the agent's own runtime cannot spawn any child process in this
#  session (pwsh -> "spawn ...powershell.exe ENOENT"), so it cannot run a zip
#  tool. This script does the whole job and verifies its own output.
#
#  Run:
#    powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-plugin-prompt-optimizer\tools\pack-to-D-AI.ps1"
#
#  Output:
#    D:\AI\dsh-plugin-prompt-optimizer.zip   (+ .zip.parts\ staging folder kept)
#    D:\AI\dsh-plugin-prompt-optimizer-demo.html
#  Log: %TEMP%\dsh-pack.log
# ============================================================================

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$script:errors   = New-Object System.Collections.ArrayList
$script:warnings = New-Object System.Collections.ArrayList
$log = Join-Path $env:TEMP 'dsh-pack.log'

function Say {
  param([string]$Message, [string]$Level = 'INFO')
  $line = "[{0}] {1,-5} {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
  Write-Host $line
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch { }
  if ($Level -eq 'ERROR')   { [void]$script:errors.Add($Message) }
  if ($Level -eq 'WARN')    { [void]$script:warnings.Add($Message) }
}

# ---------------------------------------------------------------- locations
$plugin = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-plugin-prompt-optimizer'
$dest   = 'D:\AI'
$name   = 'dsh-plugin-prompt-optimizer'
$zip    = Join-Path $dest ($name + '.zip')
$demoSrc = Join-Path $plugin 'demo.html'
$demoDst = Join-Path $dest ($name + '-demo.html')

Say '=== pack skill -> D:\AI ==='
Say ("source : " + $plugin)
Say ("target : " + $zip)

# ------------------------------------------------------- 0. preconditions
if (-not (Test-Path -LiteralPath $plugin)) {
  Say ("source directory not found: " + $plugin) 'ERROR'; exit 1
}
if (-not (Test-Path -LiteralPath $dest)) {
  Say ("creating destination " + $dest)
  try { [void](New-Item -ItemType Directory -Path $dest -Force) }
  catch { Say ("cannot create " + $dest + ": " + $_.Exception.Message) 'ERROR'; exit 1 }
}

# ------------------------------------------------- 1. inventory + checks
$required = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js')
foreach ($rel in $required) {
  $p = Join-Path $plugin $rel
  if (Test-Path -LiteralPath $p) {
    Say ("ok    required " + $rel + " (" + (Get-Item -LiteralPath $p).Length + " bytes)")
  } else {
    Say ("missing required file: " + $rel) 'ERROR'
  }
}
if ($script:errors.Count -gt 0) { Say 'aborting: required files missing' 'ERROR'; exit 1 }

# stage everything into D:\AI so the archive is built on the destination volume
$stageRoot = Join-Path $dest '.zip.parts'
$stage = Join-Path $stageRoot $name
try {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  [void](New-Item -ItemType Directory -Path $stage -Force)
} catch {
  Say ("cannot prepare staging folder " + $stage + ": " + $_.Exception.Message) 'ERROR'; exit 1
}

Say 'copying files into staging ...'
$files = Get-ChildItem -LiteralPath $plugin -Recurse -File -Force
$copied = 0; $totalBytes = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($plugin.Length).TrimStart('\')
  $target = Join-Path $stage $rel
  $dir = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  Copy-Item -LiteralPath $f.FullName -Destination $target -Force
  $copied++; $totalBytes += $f.Length
  Say ("  + " + $rel + "  (" + $f.Length + " B)")
}
Say ("staged " + $copied + " file(s), " + $totalBytes + " bytes")

# ------------------------------------------------------------- 2. create zip
if (Test-Path -LiteralPath $zip) {
  try { Remove-Item -LiteralPath $zip -Force; Say 'removed previous archive' }
  catch { Say ("previous archive is locked, writing a new name: " + $_.Exception.Message) 'WARN'
          $zip = Join-Path $dest ($name + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip') }
}

try {
  $full = [System.IO.Path]::GetFullPath($zip)
  $archive = [System.IO.Compression.ZipFile]::Open($full, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    # the root folder inside the archive is the skill's own directory name
    [void]$archive.CreateEntry($name + '/')
    foreach ($f in Get-ChildItem -LiteralPath $stage -Recurse -File -Force) {
      $rel = $f.FullName.Substring($stage.Length).TrimStart('\')
      $entryName = ($name + '/' + $rel).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
  } finally { $archive.Dispose() }
  Say ("created " + $full)
} catch {
  Say ("zip creation failed: " + $_.Exception.Message) 'ERROR'; exit 1
}

# ------------------------------------------------- 3. verify by extracting
$verify = Join-Path $stageRoot ('_verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$verifyOk = $false
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $verify)
  Say 'extraction ok'

  $srcFiles = Get-ChildItem -LiteralPath $stage -Recurse -File -Force |
              ForEach-Object { $_.FullName.Substring($stage.Length).TrimStart('\') } | Sort-Object
  $zipRoot  = Join-Path $verify $name
  if (-not (Test-Path -LiteralPath $zipRoot)) {
    Say ("archive has no top-level folder " + $name) 'ERROR'
  } else {
    $outFiles = Get-ChildItem -LiteralPath $zipRoot -Recurse -File -Force |
                ForEach-Object { $_.FullName.Substring($zipRoot.Length).TrimStart('\') } | Sort-Object
    $missing = @($srcFiles | Where-Object { $outFiles -notcontains $_ })
    $extra   = @($outFiles | Where-Object { $srcFiles -notcontains $_ })
    if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
      Say ("structure verified: " + $outFiles.Count + " file(s), identical to source staging")
      $verifyOk = $true
    } else {
      if ($missing.Count -gt 0) { Say ("missing from archive: " + ($missing -join ', ')) 'ERROR' }
      if ($extra.Count   -gt 0) { Say ("unexpected in archive: " + ($extra   -join ', ')) 'ERROR' }
    }
  }
} catch {
  Say ("verification extract failed: " + $_.Exception.Message) 'ERROR'
} finally {
  if (Test-Path -LiteralPath $verify) { Remove-Item -LiteralPath $verify -Recurse -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------- 4. demo HTML
if (-not (Test-Path -LiteralPath $demoSrc)) {
  Say ("demo source missing: " + $demoSrc) 'ERROR'
} else {
  try {
    Copy-Item -LiteralPath $demoSrc -Destination $demoDst -Force
    $demoLen = (Get-Item -LiteralPath $demoDst).Length
    $head = (Get-Content -LiteralPath $demoDst -TotalCount 1)
    if ($head -match '<!DOCTYPE html>') {
      Say ("demo html ok: " + $demoDst + " (" + $demoLen + " bytes, starts with DOCTYPE)")
    } else {
      Say ("demo html does not start with <!DOCTYPE html>") 'WARN'
    }
  } catch {
    Say ("copy demo html failed: " + $_.Exception.Message) 'ERROR'
  }
}

# ------------------------------------------------------------- 5. summary
Say '--- summary ---'
if (Test-Path -LiteralPath $zip) { Say ("zip  : " + $zip + "  (" + (Get-Item -LiteralPath $zip).Length + " bytes)") }
if (Test-Path -LiteralPath $demoDst) { Say ("html : " + $demoDst + "  (" + (Get-Item -LiteralPath $demoDst).Length + " bytes)") }
Say ("staging folder kept for inspection: " + $stage)

if ($script:warnings.Count -gt 0) { foreach ($w in $script:warnings) { Say ("warning: " + $w) 'WARN' } }
if ($script:errors.Count -eq 0 -and $verifyOk) {
  Say 'RESULT: OK - archive created and structure verified.'
  exit 0
} else {
  Say 'RESULT: FAILED - see ERROR lines above.'
  if ($script:errors.Count -gt 0) { foreach ($e in $script:errors) { Write-Host ("  ERROR: " + $e) } }
  exit 2
}
