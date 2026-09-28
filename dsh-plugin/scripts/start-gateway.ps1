# 静默启动 WorkBuddy 中转网关内核（不启动 Electron 桌面窗口）。
#
# 由计划任务在登录时调用，或手动跑。做的事和桌面版启动器一样，只是没有窗口：
# 用独立的 Python 跑 launcher.py，把内核挂在 127.0.0.1:8787。
#
# 幂等：如果内核已在监听，直接退出，不会起第二个。
#
# 用法：
#   pwsh -File start-gateway.ps1 -GatewayRoot <网关安装目录>
# 不传 -GatewayRoot 时会自动探测：优先用插件自带的 payload，
# 其次找常见安装位。

param(
  [string]$GatewayRoot = '',
  [string]$DataDir     = "$env:APPDATA\codebuddy-gateway",
  [int]$Port           = 8787,
  [string]$LogFile     = "$env:APPDATA\codebuddy-gateway\autostart.log"
)

$ErrorActionPreference = 'Stop'

# 没指定就用插件自带的 payload（插件自足，不依赖外部安装）
if (-not $GatewayRoot) {
  $bundled = Join-Path (Split-Path -Parent $PSScriptRoot) 'payload'
  if (Test-Path (Join-Path $bundled 'launcher.py')) {
    $GatewayRoot = $bundled
  } else {
    $GatewayRoot = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy 中转网关'
  }
}

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

# --- 便携运行时（兼容客户端目录是安装根或安装根下的 resources）---
$python = @(
  (Join-Path $GatewayRoot 'python\python.exe'),
  (Join-Path $GatewayRoot 'resources\python\python.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$launcher = @(
  (Join-Path $GatewayRoot 'launcher.py'),
  (Join-Path $GatewayRoot 'resources\launcher.py')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$kernel = @(
  (Join-Path $GatewayRoot 'kernel'),
  (Join-Path $GatewayRoot 'resources\kernel')
) | Where-Object { Test-Path (Join-Path $_ 'core\converter.py') } | Select-Object -First 1

if (-not $python)   { Write-Log "找不到 python.exe（GatewayRoot=$GatewayRoot）"; exit 2 }
if (-not $launcher) { Write-Log "找不到 launcher.py（GatewayRoot=$GatewayRoot）"; exit 3 }
if (-not $kernel)   { Write-Log "找不到内核目录（GatewayRoot=$GatewayRoot）"; exit 4 }

# --- 已经在跑就别重复启动 ---
$listening = $false
try {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($conn) { $listening = $true }
} catch { }
if ($listening) {
  Write-Log "端口 $Port 已在监听，内核应该已经在跑，跳过。"
  exit 0
}

$keysFile = Join-Path $DataDir 'keys.json'
$desktopFile = Join-Path $DataDir 'desktop.json'
if (-not (Test-Path $keysFile)) { Write-Log "缺少 keys.json：$keysFile"; exit 5 }

# 客户端 key 从 desktop.json 读；没有就留空（内核会沿用已存的）
$clientKey = ''
if (Test-Path $desktopFile) {
  try { $clientKey = (Get-Content $desktopFile -Raw | ConvertFrom-Json).clientKey } catch { }
}

$args = @(
  '-u', $launcher,
  '--project-dir', $kernel,
  '--host', '127.0.0.1',
  '--port', "$Port",
  '--data-dir', (Join-Path $DataDir 'gateway-data'),
  '--admin-key-file', $keysFile,
  '--client-key', $clientKey
)

Write-Log "启动内核：$python"
Write-Log "  内核目录: $kernel"
Write-Log "  端口: $Port"

# 环境变量清干净：宿主可能注入 PYTHONHOME / PYTHONPATH，会让便携解释器跑偏
$env:PYTHONHOME = ''
$env:PYTHONPATH = ''
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

Start-Process -FilePath $python -ArgumentList $args `
  -WorkingDirectory $kernel -WindowStyle Hidden -PassThru | Out-Null

# 等健康检查通过，最多 30s（计划任务里不阻塞太久）
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Write-Log "内核已就绪：$($r.Content)"; exit 0 }
  } catch { }
  Start-Sleep -Milliseconds 500
}
Write-Log "内核启动超时（30s），请查看 gateway-data 下的日志。"
exit 6
