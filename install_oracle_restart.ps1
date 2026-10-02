# ติดตั้งสิทธิ์ให้หน้าสถานะ (statusprogram) สั่งเปิดฐานข้อมูล Oracle ใหม่ได้เอง — รันครั้งเดียวด้วยสิทธิ์ผู้ดูแล
# สร้างงานชื่อ "KohKae Restart Oracle" ใน Task Scheduler (รันเป็น SYSTEM เฉพาะตอนถูกสั่ง ไม่มีตารางเวลา)
# แล้วอนุญาตให้ผู้ใช้ที่ล็อกอินอยู่ "สั่งรัน" งานนี้ได้ (แก้/ลบไม่ได้)
# ถอนการติดตั้ง:  schtasks /Delete /TN "KohKae Restart Oracle" /F   (ในหน้าต่างผู้ดูแล)
$ErrorActionPreference = "Stop"
$taskName = "KohKae Restart Oracle"
$service  = "OracleServiceXE"
$listener = (Get-Service "Oracle*TNSListener" -ErrorAction SilentlyContinue | Select-Object -First 1).Name

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[X] Please run this as administrator (right-click install_oracle_restart.bat -> Run as administrator)" -ForegroundColor Red
    exit 1
}
if (-not (Get-Service $service -ErrorAction SilentlyContinue)) { Write-Host "[X] Service $service not found" -ForegroundColor Red; exit 1 }

$cmd = "Restart-Service -Name '$service' -Force"
if ($listener) { $cmd += "; if ((Get-Service '$listener').Status -ne 'Running') { Start-Service '$listener' }" }
$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$cmd`""
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force `
    -Description "KohKae statusprogram: restart Oracle when the database stops responding (run on demand only)" | Out-Null

# อนุญาตให้ผู้ใช้ที่เปิดระบบ (ไม่ได้ยกสิทธิ์) สั่งรันงานนี้ได้: เพิ่มสิทธิ์อ่าน+รันให้ Authenticated Users
$sched = New-Object -ComObject Schedule.Service
$sched.Connect()
$task = $sched.GetFolder("\").GetTask($taskName)
$sddl = $task.GetSecurityDescriptor(0xF)
if ($sddl -notmatch "A;;GRGX;;;AU") { $task.SetSecurityDescriptor($sddl + "(A;;GRGX;;;AU)", 0) }

Write-Host "[OK] Installed task '$taskName' (restarts $service)" -ForegroundColor Green
