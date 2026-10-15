# Installs Pyrite on Windows for this user only, from the unzipped trial folder. Install Pyrite.cmd
# runs it; running it again repeats every step safely. It writes only Pyrite's own files and keys:
#   %LOCALAPPDATA%\Pyrite\app                  a copy of the whole package, which everything points at
#   %LOCALAPPDATA%\Pyrite\app\bridge\pyrite-bridge.bat
#   %LOCALAPPDATA%\Pyrite\cwd, config.json and com.pyrite.bridge.json
#   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pyrite.bridge
#   HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pyrite.bridge
# When %USERPROFILE%\.local\bin\claude.exe is missing it runs Anthropic's own Claude Code installer,
# which puts it there. It reads, never writes, HKLM: only to find msedge.exe or chrome.exe.
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 [-Model id] [-DryRun]
#
# -DryRun writes every file under a temp folder instead, touches no registry, makes no web call and
# runs no claude probe; off Windows it also skips the clipboard and Chrome.
#
# Written for Windows PowerShell 5.1, the one every Windows 10 and 11 has: ASCII only, and none of
# PowerShell 7's operators.
param([string]$Model = 'claude-opus-5-5', [switch]$DryRun)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 still offers TLS 1.0 first, which claude.ai refuses.
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'

# Anything unforeseen still ends the way every failure here does, readable in the window.
trap {
  Write-Host ''
  Write-Host ('FAIL ' + $_.Exception.Message)
  Write-Host 'Send a screenshot of this window.'
  exit 1
}

# Must equal EXTENSION_ID in pyrite-bridge.mjs; a unit test keeps the two equal.
$ExtensionId = 'hegfbajilkihmgclmnajpkhckogfplni'
$HostName = 'com.pyrite.bridge'
$Fallback = 'claude-sonnet-5-5'
# Copied from AUTH_TEXT in pyrite-bridge.mjs, the bridge's own "not logged in" test; a unit test keeps
# the two equal. -match ignores case, as the bridge's /i does.
$AuthText = '/login|not logged in|invalid api key|oauth token|oauth session expired|failed to authenticate|login expired'
$Ask = 'reply with the word ok'
# Node.js for Windows, pinned to the exact files verified for this package. Their source is
# vendor/node-win-x64/VERSION; make-trial.sh fails when these differ from it.
$NodeVersion = 'v24.21.0'
$NodeZipName = 'node-v24.21.0-win-x64.zip'
$NodeZipSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$NodeExeSha256 = 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
$NodeUrl = 'https://nodejs.org/dist/' + $NodeVersion + '/' + $NodeZipName

# Windows PowerShell 5.1 has no $IsWindows; only pwsh off Windows sets it false.
$OnWindows = ($null -eq $IsWindows) -or $IsWindows
$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) { $LocalAppData = Join-Path (Join-Path $HOME 'AppData') 'Local' }
$UserProfile = $env:USERPROFILE
if (-not $UserProfile) { $UserProfile = $HOME }

# The unzipped folder: the parent of bridge\.
$Package = Split-Path -Parent $PSScriptRoot
$Pyrite = Join-Path $LocalAppData 'Pyrite'
$App = Join-Path $Pyrite 'app'
$Cwd = Join-Path $Pyrite 'cwd'
$ConfigPath = Join-Path $Pyrite 'config.json'
$ManifestPath = Join-Path $Pyrite ($HostName + '.json')
$AppBridge = Join-Path $App 'bridge'
$BatPath = Join-Path $AppBridge 'pyrite-bridge.bat'
$NodeExe = Join-Path (Join-Path $App 'node') 'node.exe'
$ExtensionDir = Join-Path $App 'extension'
# The native installer's claude.exe. npm's claude.cmd and claude.ps1 need a shell, and the bridge refuses those.
$Claude = Join-Path (Join-Path (Join-Path $UserProfile '.local') 'bin') 'claude.exe'
$ChromeKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName
$EdgeKey = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName

# A dry run writes the same files at the same paths, below a temp folder.
$Root = $null
if ($DryRun) {
  $Root = Join-Path ([System.IO.Path]::GetTempPath()) ('pyrite-dry-run-' + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Root | Out-Null
}

function Get-Target([string]$Path) {
  if ($null -eq $Root) { return $Path }
  return Join-Path $Root ($Path -replace ':', '')
}

function Stop-Install([string]$Why) {
  Write-Host ''
  Write-Host ('FAIL ' + $Why)
  exit 1
}

# UTF-8 without a byte-order mark: Windows PowerShell's own Set-Content -Encoding UTF8 adds one.
function Write-PyriteFile([string]$Path, [string]$Text) {
  $Target = Get-Target $Path
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
  [System.IO.File]::WriteAllText($Target, $Text, (New-Object System.Text.UTF8Encoding $false))
  Write-Host ('write    ' + $Path)
}

# claude -p with one short question, run in Pyrite's own cwd, 90 s at most. Ok is a clean answer;
# Auth is the bridge's not-logged-in text anywhere in what it printed; Last is its last line.
function Invoke-Probe([string[]]$Extra) {
  $Out = [System.IO.Path]::GetTempFileName()
  $Err = [System.IO.Path]::GetTempFileName()
  $Arguments = @('-p') + $Extra + @('--max-turns', '1', ('"' + $Ask + '"'))
  $P = Start-Process -FilePath $Claude -ArgumentList $Arguments -WorkingDirectory $Cwd -NoNewWindow -PassThru -RedirectStandardOutput $Out -RedirectStandardError $Err
  # Windows PowerShell 5.1 loses the exit code unless the handle is taken before the process ends
  $Handle = $P.Handle
  $Done = $P.WaitForExit(90000)
  if (-not $Done) {
    try { $P.Kill() } catch { }
  }
  $Text = [string](Get-Content -Raw -LiteralPath $Out) + [string](Get-Content -Raw -LiteralPath $Err)
  Remove-Item -LiteralPath $Out, $Err -Force -ErrorAction SilentlyContinue
  $Lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  $Last = 'claude printed nothing'
  if ($Lines.Count -gt 0) { $Last = $Lines[$Lines.Count - 1].Trim() }
  if (-not $Done) { $Last = 'claude did not answer within 90 s' }
  $Auth = $Text -match $AuthText
  return @{ Ok = ($Done -and $P.ExitCode -eq 0 -and -not $Auth); Auth = $Auth; Last = $Last }
}

Write-Host 'Pyrite install'
if ($DryRun) { Write-Host ('Dry run: every file below is written under ' + $Root + ' instead; no registry, no web call, no claude probe') }
Write-Host ''

# The package must be whole: a file opened straight from the zip runs alone, without its folder.
foreach ($Part in @('extension\manifest.json', 'bridge\pyrite-bridge.mjs', 'utils\claude\deep-system-prompt.md')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Package $Part))) { Stop-Install ('This folder is missing ' + $Part + '. Extract the whole zip (right-click it, Extract All), then run Install Pyrite.cmd from the extracted folder.') }
}

function Test-NodeExe([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $NodeExeSha256
}

function Stop-Download([string]$Why) {
  Stop-Install ('Could not download Node.js: ' + $Why + '. Check the internet connection and run Install Pyrite.cmd again.')
}

# a. The app copy, so the download can be deleted. A node folder (the backup package has one) is
# left alone when the app already holds the pinned node.exe, since a running bridge holds it open.
$AppTarget = Get-Target $App
$FromApp = [System.IO.Path]::GetFullPath($Package).TrimEnd('\', '/') -eq [System.IO.Path]::GetFullPath($AppTarget).TrimEnd('\', '/')
if ($FromApp) {
  Write-Host ('app      ' + $App + ' (running from it)')
} else {
  Write-Host ('copy     ' + $Package + ' -> ' + $App)
  New-Item -ItemType Directory -Force -Path $AppTarget | Out-Null
  $OldExtension = Join-Path $AppTarget 'extension'
  if (Test-Path -LiteralPath $OldExtension) { Remove-Item -LiteralPath $OldExtension -Recurse -Force }
  foreach ($Item in Get-ChildItem -LiteralPath $Package -Force) {
    if ($Item.Name -eq 'node') {
      if (Test-NodeExe (Join-Path (Join-Path $AppTarget 'node') 'node.exe')) { continue }
    }
    Copy-Item -LiteralPath $Item.FullName -Destination $AppTarget -Recurse -Force
  }
}
Write-Host ('create   ' + $Cwd)
New-Item -ItemType Directory -Force -Path (Get-Target $Cwd) | Out-Null

# Node.js: the pinned node.exe in the app (bundled, or from an earlier run), else the pinned zip
# from nodejs.org. WebClient, not Invoke-WebRequest, whose 5.1 progress bar slows a big download.
$NodeTarget = Get-Target $NodeExe
if (Test-NodeExe $NodeTarget) {
  Write-Host ('node     ' + $NodeExe)
} elseif ($DryRun) {
  Write-Host ('would download ' + $NodeUrl + ' and check its SHA-256, then node.exe''s')
} else {
  Write-Host ('Downloading Node.js ' + $NodeVersion + ' (about 37 MB)')
  $NodeDir = Split-Path -Parent $NodeTarget
  $NodeZip = Join-Path ([System.IO.Path]::GetTempPath()) ('pyrite-' + [System.Guid]::NewGuid().ToString('N') + '.zip')
  try {
    (New-Object System.Net.WebClient).DownloadFile($NodeUrl, $NodeZip)
  } catch {
    Remove-Item -LiteralPath $NodeZip -Force -ErrorAction SilentlyContinue
    Stop-Download $_.Exception.Message
  }
  if ((Get-FileHash -LiteralPath $NodeZip -Algorithm SHA256).Hash -ne $NodeZipSha256) {
    Remove-Item -LiteralPath $NodeZip -Force
    Stop-Download 'the download is not the expected file'
  }
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
    $Zip = [System.IO.Compression.ZipFile]::OpenRead($NodeZip)
    try {
      foreach ($Name in @('node.exe', 'LICENSE')) {
        $Entry = $Zip.GetEntry('node-' + $NodeVersion + '-win-x64/' + $Name)
        if ($null -eq $Entry) { throw ($Name + ' is not in the zip') }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, (Join-Path $NodeDir $Name), $true)
      }
    } finally {
      $Zip.Dispose()
    }
  } catch {
    Remove-Item -LiteralPath $NodeZip -Force -ErrorAction SilentlyContinue
    Stop-Download $_.Exception.Message
  }
  Remove-Item -LiteralPath $NodeZip -Force
  if (-not (Test-NodeExe $NodeTarget)) { Stop-Download 'node.exe is not the expected file' }
  # the same VERSION make-trial.sh ships: version, zip, the zip's SHA-256, node.exe's
  [System.IO.File]::WriteAllText((Join-Path $NodeDir 'VERSION'), ($NodeVersion + "`n" + $NodeZipName + "`n" + $NodeZipSha256 + "`n" + $NodeExeSha256 + "`n"), (New-Object System.Text.UTF8Encoding $false))
  Write-Host ('node     ' + $NodeExe)
}

# b. The Claude CLI.
if (Test-Path -LiteralPath $Claude -PathType Leaf) {
  Write-Host ('claude   ' + $Claude)
} elseif ($DryRun) {
  Write-Host ('claude   not at ' + $Claude + '; would run Anthropic''s installer: irm https://claude.ai/install.ps1 | iex')
} else {
  Write-Host 'Installing Claude Code''s command line (Anthropic''s installer)'
  # its own PowerShell, so an exit inside Anthropic's script cannot end this one
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; irm https://claude.ai/install.ps1 | iex"
  $InstallerExit = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $Claude -PathType Leaf)) { Stop-Install ('Claude Code did not install (the installer exited with ' + $InstallerExit + '). Send a screenshot of this window.') }
  Write-Host ('claude   ' + $Claude)
}

# c. The login, then d. the model.
if ($DryRun) {
  Write-Host ('would probe: claude.exe -p --max-turns 1 "' + $Ask + '" in ' + $Cwd + ', and log in if it is not')
  Write-Host ('would probe: claude.exe -p --model ' + $Model + ' --max-turns 1, then ' + $Fallback + ' if that fails')
} else {
  Write-Host 'Checking the Claude login'
  $Probe = Invoke-Probe @()
  if ($Probe.Auth) {
    Write-Host 'Log in to Claude in the window that opens, then close that window'
    # claude.exe alone is waited for, not whatever it leaves running
    $Login = Start-Process -FilePath $Claude -WorkingDirectory $Cwd -PassThru
    $Login.WaitForExit()
    $Probe = Invoke-Probe @()
    if ($Probe.Auth) { Stop-Install 'Log in to Claude, then run Install Pyrite.cmd again.' }
  }
  Write-Host ('Checking the model ' + $Model)
  $Probe = Invoke-Probe @('--model', $Model)
  if ($Probe.Auth) { Stop-Install 'Log in to Claude, then run Install Pyrite.cmd again.' }
  if (-not $Probe.Ok) {
    $Second = Invoke-Probe @('--model', $Fallback)
    if ($Second.Auth) { Stop-Install 'Log in to Claude, then run Install Pyrite.cmd again.' }
    if (-not $Second.Ok) {
      Write-Host ''
      Write-Host ('FAIL ' + $Second.Last)
      Write-Host 'Send a screenshot of this window.'
      exit 1
    }
    $Model = $Fallback
    Write-Host 'Your plan can''t run Opus 5.5. Pyrite will use Sonnet 5.5.'
  }
}

# e. The registration. The deep check runs the model at its own effort (DEEP_EFFORT in
# pyrite-bridge.mjs), so the config names no effort.
$Config = [ordered]@{ node = $NodeExe; claude = $Claude; cwd = $Cwd; model = $Model }
$Manifest = [ordered]@{
  name = $HostName
  description = 'Pyrite bridge'
  path = $BatPath
  type = 'stdio'
  allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
}
# The bundled node.exe beside the bridge, both found from this .bat's own folder at run time
# (%~dp0 ends in a backslash), so a user folder named in any alphabet needs no code page here.
$Bat = '@echo off' + "`r`n" + '"%~dp0..\node\node.exe" "%~dp0pyrite-bridge.mjs" %*' + "`r`n"
Write-PyriteFile $ConfigPath (($Config | ConvertTo-Json) + "`n")
Write-PyriteFile $BatPath $Bat
Write-PyriteFile $ManifestPath (($Manifest | ConvertTo-Json) + "`n")
foreach ($RegKey in @($ChromeKey, $EdgeKey)) {
  Write-Host ('registry ' + $RegKey + ' (default) = ' + $ManifestPath)
  if (-not $DryRun) {
    New-Item -Path $RegKey -Force | Out-Null
    Set-Item -Path $RegKey -Value $ManifestPath
  }
}
# The installer's own read-back of what it just wrote, in PowerShell, which reads any alphabet. A
# failed check here or in the self-test is kept, and said after the hand-off, which runs either way.
$SelfTestFailed = $false
if (-not $DryRun) {
  foreach ($Pair in @(@('Chrome', $ChromeKey), @('Edge', $EdgeKey))) {
    $Wrote = (Get-Item $Pair[1]).GetValue('') -eq $ManifestPath
    if ($Wrote) { Write-Host ('PASS ' + $Pair[0] + ' registration: ' + $ManifestPath) } else {
      Write-Host ('FAIL ' + $Pair[0] + ' registration: not read back')
      $SelfTestFailed = $true
    }
  }
}

# f. The self-test, with the bundled node, as the browser will run the bridge.
Write-Host ''
if ($DryRun) {
  Write-Host ('would run: "' + $NodeExe + '" "' + (Join-Path $AppBridge 'pyrite-bridge.mjs') + '" --selftest')
} else {
  Write-Host 'Self-test (this can take up to 3 minutes)'
  & $NodeExe (Join-Path $AppBridge 'pyrite-bridge.mjs') --selftest
  # kept, not acted on yet: the hand-off below runs either way
  if ($LASTEXITCODE -ne 0) { $SelfTestFailed = $true }
}

# g. The hand-off: the folder to load in the clipboard, and the browser on its extensions page.
# 0.2.13: Edge first (Pyrite is an Edge extension, and the bundled CLAUDE.md and READ-ME say Edge),
# Chrome only when Edge is not found. Both are registered above either way.
Write-Host ''
if ($OnWindows) { Set-Clipboard -Value $ExtensionDir }
Write-Host ('The folder to load (in your clipboard): ' + $ExtensionDir)
function Find-AppPath([string]$Exe) {
  foreach ($Hive in @('HKLM:', 'HKCU:')) {
    $AppPath = $Hive + '\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $Exe
    if (Test-Path -LiteralPath $AppPath) {
      $Found = [string](Get-Item -LiteralPath $AppPath).GetValue('')
      $Found = $Found.Trim('"')
      if ($Found -and (Test-Path -LiteralPath $Found -PathType Leaf)) { return $Found }
    }
  }
  return $null
}
$Browser = 'Edge'
$BrowserPage = 'edge://extensions'
$BrowserExe = $null
if ($OnWindows) {
  $BrowserExe = Find-AppPath 'msedge.exe'
  if ($null -eq $BrowserExe) {
    $Chrome = Find-AppPath 'chrome.exe'
    if ($null -ne $Chrome) { $BrowserExe = $Chrome; $Browser = 'Chrome'; $BrowserPage = 'chrome://extensions' }
  }
}
if ($null -ne $BrowserExe) {
  Start-Process -FilePath $BrowserExe -ArgumentList $BrowserPage
} else {
  Write-Host 'Open Edge and go to edge://extensions (in Chrome: chrome://extensions)'
}
if ($DryRun) { Write-Host ('Dry run done. Nothing outside ' + $Root + ' was written.') }
Write-Host ''
Write-Host 'Pyrite helper installed.'
Write-Host ('Next, in ' + $Browser + '''s extensions page: turn on Developer mode, click Load unpacked, click the Folder box at the bottom, press Ctrl+V, press Enter, then click Select Folder.')
if ($SelfTestFailed) {
  Write-Host ''
  Write-Host ('Some checks failed. Take a screenshot of this window and send it back, then carry on in ' + $Browser + '.')
  exit 1
}
