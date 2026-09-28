# 组装插件自带的运行时 payload。
#
# 把一份可重定位的 Python + 内核源码 + launcher.py 收进 dsh-plugin/payload/，
# 使插件在「用户只装了 WorkBuddy 并登录、没有任何网关」的机器上也能一键跑起来。
#
# payload 是**构建产物**，不进 git（见 ../.gitignore）。
#
# 用法：
#   pwsh -File scripts/build-payload.ps1                      # 自动找来源
#   pwsh -File scripts/build-payload.ps1 -Source <目录>        # 指定来源
#   pwsh -File scripts/build-payload.ps1 -KernelOnly           # 只更新内核
#
# 来源可以是以下之一（含 resources/ 子目录也认）：
#   1. 已安装的「WorkBuddy 中转网关」 —— 自带 python + launcher + kernel
#   2. 仓库里已有的 payload            —— 用它现有的 python，只换内核
#   3. 本仓库的 build/kernel           —— 只要有 python 来源，可单独作内核来源
#
# 内核源码在仓库的 build/kernel/（已纳入版本控制）；Python 运行时不在仓库里，
# 必须来自已安装的网关或一份已有的 payload。

param(
  [string]$Source = '',
  [switch]$Force,
  [switch]$KernelOnly
)

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $PSScriptRoot
$payload   = Join-Path $pluginDir 'payload'
$repoRoot  = Split-Path -Parent $pluginDir

function Find-Source {
  $candidates = @()
  if ($Source) { $candidates += $Source }
  # 环境变量（便于 CI 或自定义安装位）
  if ($env:CODEBUDDY_GATEWAY_ROOT) { $candidates += $env:CODEBUDDY_GATEWAY_ROOT }
  # 常见安装位
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy 中转网关'),
    (Join-Path $env:ProgramFiles 'WorkBuddy 中转网关')
  )
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    foreach ($base in @($c, (Join-Path $c 'resources'))) {
      $py = Join-Path $base 'python\python.exe'
      $ln = Join-Path $base 'launcher.py'
      $kn = Join-Path $base 'kernel\core\converter.py'
      if ((Test-Path $py) -and (Test-Path $ln) -and (Test-Path $kn)) {
        return @{ Root = $base; Python = $py; Launcher = $ln; Kernel = (Join-Path $base 'kernel') }
      }
    }
  }
  return $null
}

# 回退：用现有 payload 的 Python + 仓库 build/kernel 的内核。
# 适用场景：网关已卸载（用户不再需要它），但已有 payload 或仓库里有内核副本。
function Find-Fallback {
  $py = Join-Path $payload 'python\python.exe'
  $ln = Join-Path $payload 'launcher.py'
  $kn = Join-Path $repoRoot 'build\kernel'
  if (-not (Test-Path $py)) { return $null }
  if (-not (Test-Path (Join-Path $kn 'core\converter.py'))) { return $null }
  return @{
    Root     = $payload
    Python   = $py
    Launcher = $ln
    Kernel   = $kn
    Reuse    = $true   # 标记：Python 复用现有 payload，不要删它
  }
}

$src = Find-Source
$reusing = $false
if (-not $src) {
  $fb = Find-Fallback
  if ($fb) {
    Write-Output "没找到已安装的网关，改用回退来源："
    Write-Output "  Python : $($fb.Python)  （复用现有 payload）"
    Write-Output "  内核   : $($fb.Kernel)  （来自仓库 build/kernel）"
    $src = $fb
    $reusing = $true
  }
}
if (-not $src) {
  Write-Error @"
找不到任何来源。请用 -Source 指定一个含 python、launcher.py、kernel 的目录，
例如已安装的「WorkBuddy 中转网关」。

也可以先用一份已有的 payload：把 dsh-plugin\payload\ 从别的机器复制过来，
再运行本脚本用仓库 build/kernel 里的内核刷新它。
"@
  exit 1
}
if (-not $reusing) { Write-Output "源目录: $($src.Root)" }

# -KernelOnly：只换内核，保留现有 Python（避免重装或重新下载 52MB）
if ($KernelOnly -or $reusing) {
  if (-not (Test-Path (Join-Path $payload 'python'))) {
    Write-Error "-KernelOnly 需要 payload\python 已存在。"
    exit 1
  }
  Write-Output "只更新内核（保留现有 Python 运行时）…"
} else {
  if ((Test-Path $payload) -and -not $Force) {
    Write-Output "payload 已存在。要重建请加 -Force，或加 -KernelOnly 只换内核。"
    exit 0
  }
}
if (-not $reusing) { New-Item -ItemType Directory -Force -Path $payload | Out-Null }

# --- 1. Python 运行时（排除 __pycache__：省 ~10MB，且首次运行会自动重建）---
if (-not ($KernelOnly -or $reusing)) {
  if (Test-Path (Join-Path $payload 'python')) { Remove-Item -Recurse -Force (Join-Path $payload 'python') }
  Write-Output "复制 Python 运行时…"
  robocopy (Split-Path -Parent $src.Python) (Join-Path $payload 'python') /E `
    /NFL /NDL /NJH /NJS /NP /XD __pycache__ | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Error "robocopy 失败: $LASTEXITCODE"; exit 2 }
}

# --- 2. 内核（排除测试、.venv、deploy：用户不需要；.venv 有十几 MB）---
Write-Output "复制内核…"
$kernelDst = Join-Path $payload 'kernel'
# /PURGE：清掉目标里来源已不存在的文件，否则反复构建会累积残留。
# 注意：/PURGE 不会删除被 /XD 排除的目录（robocopy 根本不看它们），
# 所以下面还要显式清一次这些名字，否则复用旧 payload 时会残留上一轮的 .venv。
robocopy $src.Kernel $kernelDst /E /PURGE `
  /NFL /NDL /NJH /NJS /NP /XD __pycache__ tests .venv deploy | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy 失败: $LASTEXITCODE"; exit 2 }
foreach ($junk in @('__pycache__', 'tests', '.venv', 'deploy')) {
  $jp = Join-Path $kernelDst $junk
  if (Test-Path $jp) {
    Remove-Item -Recurse -Force $jp -ErrorAction SilentlyContinue
    Write-Output "  清理残留: $junk"
  }
}

# --- 3. 启动器 ---
# 复用现有 payload 时，来源与目标可能是同一个文件，跳过以免 Copy-Item 报
# "Cannot overwrite the item ... with itself"。
$launcherDst = Join-Path $payload 'launcher.py'
if ($src.Launcher -and (Test-Path $src.Launcher)) {
  $same = $false
  try {
    $same = (Resolve-Path $src.Launcher).Path -eq (Resolve-Path $launcherDst -ErrorAction SilentlyContinue).Path
  } catch { $same = $false }
  if ($same) {
    Write-Output "launcher.py 已是最新（来源与目标相同，跳过）"
  } else {
    Copy-Item $src.Launcher $launcherDst -Force
    Write-Output "复制 launcher.py"
  }
} elseif (-not (Test-Path $launcherDst)) {
  Write-Warning "没有 launcher.py 可复制，且 payload 里也没有 —— 内核将无法启动。"
}

# --- 4. 许可文件：二次分发时必须随包带上 ---
# 内核是第三方 MIT 项目（HanHan666666 / Chris），Python 是 PSF License。
# robocopy 只复制了运行时目录本身，许可文件常在别处，所以这里单独找并复制。
# 目标目录与来源可能重叠（复用 payload 时），所以每次先比对路径。
function Copy-License($from, $toName, $label) {
  if (-not $from -or -not (Test-Path $from)) { return $null }
  $to = Join-Path $payload $toName
  $same = $false
  try { $same = (Resolve-Path $from).Path -eq (Resolve-Path $to -ErrorAction SilentlyContinue).Path } catch { }
  if ($same) { return "$toName（已存在，跳过）" }
  Copy-Item $from $to -Force
  return "$toName (来自 $(Split-Path -Leaf $from))"
}

$licenses = @()
# 内核 LICENSE 通常在 kernel 目录本身，偶尔在它上一级（安装布局不同），两处都找
$kernelLic = @(
  (Get-ChildItem $src.Kernel -File -Filter 'LICENSE*' -ErrorAction SilentlyContinue),
  (Get-ChildItem (Split-Path -Parent $src.Kernel) -File -Filter 'LICENSE*' -ErrorAction SilentlyContinue)
) | Where-Object { $_ } | Select-Object -First 1
if ($kernelLic) {
  $r = Copy-License $kernelLic.FullName 'LICENSE-kernel.txt' 'kernel'
  if ($r) { $licenses += "kernel → $r" }
} else {
  Write-Warning "内核目录（含上一级）没找到 LICENSE —— 二次分发前请手动补齐。"
}

$pyDir = Split-Path -Parent $src.Python
$pyLic = Get-ChildItem $pyDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^LICENSE' } | Select-Object -First 1
if ($pyLic) {
  $r = Copy-License $pyLic.FullName 'LICENSE-python.txt' 'python'
  if ($r) { $licenses += "python → $r" }
}

# 本插件自己的署名说明，始终带上
$notices = Join-Path $pluginDir 'THIRD-PARTY-NOTICES.md'
if (Test-Path $notices) {
  $r = Copy-License $notices 'THIRD-PARTY-NOTICES.md' 'notices'
  if ($r) { $licenses += $r }
}
if ($licenses.Count) {
  Write-Output "许可文件："
  $licenses | ForEach-Object { Write-Output "  $_" }
} else {
  Write-Warning "没有找到许可文件 —— 二次分发前请手动补齐（内核 MIT、Python PSF）。"
}

# --- 4. 自检：真跑一次 import，且 sys.prefix 必须等于 payload 里的路径 ---
Write-Output ""
Write-Output "自检中…"
$py = Join-Path $payload 'python\python.exe'
$kn = Join-Path $payload 'kernel'
$check = Join-Path $payload '_selfcheck.py'
@'
import sys, json, pathlib
sys.path.insert(0, sys.argv[1])
import fastapi, uvicorn, httpx  # noqa
import admin.server  # noqa
print(json.dumps({
    "prefix": sys.prefix,
    "version": sys.version.split()[0],
    "base_prefix": sys.base_prefix,
}))
'@ | Set-Content $check -Encoding utf8

$env:PYTHONHOME = ''
$env:PYTHONPATH = ''
$env:PYTHONIOENCODING = 'utf-8'
$raw = & $py $check $kn 2>&1 | Select-Object -Last 1
Remove-Item $check -Force -ErrorAction SilentlyContinue

$expect = (Resolve-Path (Join-Path $payload 'python')).Path
try {
  $info = $raw | ConvertFrom-Json
} catch {
  Write-Error "自检失败，输出：$raw"
  exit 3
}

Write-Output "  Python $($info.version)"
Write-Output "  sys.prefix = $($info.prefix)"
Write-Output "  期望       = $expect"

if ($info.prefix -ne $expect) {
  Write-Error "自检不通过：sys.prefix 不等于 payload 路径，说明这份运行时不可重定位。"
  exit 4
}

$size = (Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum
Write-Output ""
Write-Output ("自检通过 ✓  payload 体积: {0:N1} MB" -f ($size / 1MB))
