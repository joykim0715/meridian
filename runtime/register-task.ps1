param([switch]$Force)
$ErrorActionPreference = "Stop"
$existing = schtasks.exe /Query /TN "SBHNews Daily Briefing" 2>$null
if ($LASTEXITCODE -eq 0 -and -not $Force) {
  throw "SBHNews Daily Briefing is already registered. Re-run with -Force to replace it."
}
$root = Split-Path -Parent $PSScriptRoot
$probe = Join-Path $root "runtime\probe.vbs"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $probe)) { throw "probe.vbs missing: $probe" }
if (-not (Test-Path -LiteralPath $wscript)) { throw "wscript missing: $wscript" }

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}
$start = Get-Date -Format "yyyy-MM-dd"
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>SBH News daily briefing</Description>
    <URI>\SBHNews Daily Briefing</URI>
  </RegistrationInfo>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${start}T07:30:00</StartBoundary>
      <Repetition>
        <Interval>PT30M</Interval>
        <Duration>PT15H</Duration>
        <StopAtDurationEnd>true</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>$(Escape-Xml $wscript)</Command>
      <Arguments>$(Escape-Xml "//B `"$probe`"")</Arguments>
      <WorkingDirectory>$(Escape-Xml $root)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$taskFile = Join-Path $env:TEMP "sbhnews-daily-task.xml"
$utf16 = New-Object System.Text.UnicodeEncoding $false, $true
[System.IO.File]::WriteAllText($taskFile, $xml, $utf16)
schtasks.exe /Create /TN "SBHNews Daily Briefing" /XML $taskFile /F
if ($LASTEXITCODE -ne 0) { throw "schtasks exit $LASTEXITCODE" }
Write-Output "registered $root"
