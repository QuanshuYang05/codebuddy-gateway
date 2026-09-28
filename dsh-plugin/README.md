# 中转网关面板 · DSH 插件

在 DeepSeek Harness 的**右侧边栏**里管理 WorkBuddy / CodeBuddy 中转网关：
看状态、启停内核、签到、加账号。

**自带运行时，装完即用** —— 只要本机装过并登录过 WorkBuddy / CodeBuddy，
装这个插件就能直接用，**不需要另外安装任何桌面版网关**。

> 详细前置条件、依赖诊断与常见症状见 [`PREREQUISITES.md`](PREREQUISITES.md)。
> 出问题时点面板顶部的 **「体检」**，它会逐项告诉你差在哪、怎么办。

## 它解决什么

原来网关必须靠桌面版（`WorkBuddy 中转网关.exe`）托管，托盘里常驻一个窗口。
但内核本身只是个普通的 Python 进程，Electron 只是它的启动器。这个插件把
启动器的职责搬进 DSH：

| 原来 | 现在 |
|---|---|
| 双击桌面应用 | 侧边栏点「启动」，或登录时自动起 |
| 托盘图标常驻 | 没有窗口，一个后台 Python 进程 |
| 在桌面窗口里看状态 | 在 DSH 侧边栏看 |
| 在桌面窗口里签到、加账号 | 在 DSH 侧边栏点 |

## 架构

```
插件自带 payload/python + kernel
        │  Host 半 spawn 一个内核进程
        ▼
内核 127.0.0.1:8787  ←─ Node fetch（无 CORS 限制）──  Host 半
                                                        │  ctx.webServer.register
                          /codebuddy-gateway/status      │  （同源，浏览器直接可达）
                          /codebuddy-gateway/control     │
                          /codebuddy-gateway/action      │
                          /codebuddy-gateway/diagnose    ▼
                                                  Client 半（侧边栏页签）
```

**为什么由 Host 半取数**：网关（FastAPI）不返回任何 CORS 头，浏览器会拦掉每一次
跨源 fetch。Host 半跑在 Node 里，没有同源策略，取完再通过一个同源路由交给前端。

**为什么由 Host 半管进程**：内核本来就是个普通 Python 进程，Electron 只是它的
启动器。Host 半直接 spawn 它，于是不再需要那个桌面窗口。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：取数、内核进程管理、自动初始化、写操作白名单、依赖体检 |
| `client.js` | Client 半：侧边栏页签 UI |
| `payload/python/` | **随包分发的可重定位 Python 运行时**（约 51MB） |
| `payload/kernel/` | **随包分发的内核源码**（约 300KB） |
| `payload/launcher.py` | 内核启动器 |
| `cordis.patch.yml` | bundle 补丁，把这个插件插进 profile |
| `scripts/build-payload.ps1` | 组装 payload（含可重定位自检） |
| `scripts/start-gateway.ps1` | 静默启动内核（给计划任务用，可选） |
| `PREREQUISITES.md` | 前置条件、依赖诊断、常见症状对照 |
| `locale/*.json` | 插件管理页显示的名称与描述 |

## 自动初始化

首次点「启动」时，Host 半会补齐三样东西（桌面版是 Electron 那边做的，
纯插件环境没人替它做）：

| 缺件 | 后果 | 插件怎么处理 |
|---|---|---|
| `keys.json` | 内核启动即崩：`ADMIN_KEY must contain at least 20 characters` | 自动生成一枚 40 字符的 key，**无 BOM 写入** |
| 客户端 API Key | `/v1/*` 一律 401 | 调 `/admin/api/keys` 建一枚并写回 `desktop.json` |
| `auth/*.info` | 没有账号可用 | 从 `%LOCALAPPDATA%\CodeBuddyExtension\...\auth` 复制**明文**的；加密的跳过并如实报告 |

全部幂等：已有的不动。`keys.json` 必须无 BOM —— 内核的 `launcher.py` 用
`json.load` 读它，带 BOM 会解析失败并**静默回退成空值**，最后报成一句指向别处的错误。

## 从源码安装（payload 不进仓库）

`payload/`（约 52MB 的 Python 运行时 + 内核）**是构建产物，不进 git**
（理由见 [`.gitignore`](.gitignore)）。克隆后先生成它：

```powershell
# 1. 克隆
git clone <repo> && cd <repo>/dsh-plugin

# 2. 生成 payload
pwsh -File scripts/build-payload.ps1

# 3. 装进 DSH profile
dsh plugin --profile web add "file:$PWD"
```

第 2 步的来源，按以下顺序自动探测：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `-Source <目录>` | 手动指定，含 `python` + `launcher.py` + `kernel` 即可 |
| 2 | `$env:CODEBUDDY_GATEWAY_ROOT` | 便于 CI |
| 3 | 常见安装位 | `%LOCALAPPDATA%\Programs\WorkBuddy 中转网关`、`%ProgramFiles%\...` |
| 4 | **回退**：现有 `payload/python` + 仓库 `build/kernel` | 网关已卸载时用这个 |

> **第 4 条是重点**：如果你没装过网关，但仓库里有 `build/kernel/`（内核源码，
> 已纳入版本控制），可以从别处拿一份 `payload/python/` 放进 `dsh-plugin/payload/`，
> 脚本会用它 + 仓库内核拼出可用的 payload。

脚本会**自检**：真跑一次 `import fastapi,uvicorn,httpx`，并要求 `sys.prefix`
等于 payload 内的路径（证明可重定位）。不通过直接失败，避免产出
「只能在构建机跑」的包。同时自动带上三份许可文件：

```
payload/LICENSE-kernel.txt          内核 MIT（HanHan666666 / Chris）
payload/LICENSE-python.txt          Python PSF License
payload/THIRD-PARTY-NOTICES.md      署名与使用说明
```

**只更新内核**（不重装 Python，秒级完成）：

```powershell
pwsh -File scripts/build-payload.ps1 -KernelOnly
```

**完整重建**（换 Python 版本时）：

```powershell
pwsh -File scripts/build-payload.ps1 -Source <网关安装目录> -Force
```

### 为别的平台构建

当前 payload 是 Windows x64。macOS / Linux 需要在对应平台上跑同一个脚本
（它只依赖 PowerShell 与已安装的网关），然后把产物放进 `payload/`。

## 四个路由

### `GET /codebuddy-gateway/diagnose`

逐项体检五项依赖，报告「有没有 / 在哪 / 缺了怎么办 / 搜过哪些路径」。
不依赖内核是否在跑，所以在什么都没起来时也能用。

### `GET /codebuddy-gateway/status?period=day|month|year`

返回 KPI、账号池、用量、最近请求。字段经过裁剪，`last_error`、`token_refreshed`、
`uid` 这些内部细节不会透给浏览器。

### `POST /codebuddy-gateway/control?action=start|stop|restart`

启停内核。只在出现以下情况时失败：

- `stop` 时内核不是本插件启动的 → 如实告知，不擅自 kill 别人的进程
- 找不到运行时 → 提示安装位置

### `POST /codebuddy-gateway/action`（JSON body）

写操作白名单。调用方只能给一个 action 名字，**路径与请求体全部由 Host 半拼**，
客户端递不进任意 URL：

| action | 说明 |
|---|---|
| `checkin` | 全部账号签到 |
| `checkin-account` | 单账号签到（`id`） |
| `oauth-start` | 发起浏览器授权登录（`name` 可选） |
| `oauth-poll` | 轮询授权结果（`fid`） |
| `oauth-cancel` | 取消授权（`fid`） |
| `account-use` | 切到该账号消耗（`id`，连带把 routing 切成 manual） |
| `account-toggle` | 启用/停用（`id`、`enabled`） |
| `account-remove` | 删除账号（`id`） |
| `add-credential` | 导入 .info 凭据（`credential`、`name`） |
| `pool-settings` | 改调度/自动签到（`routing`、`autoCheckin`、`checkinTime`） |

## 开机自启

`scripts/start-gateway.ps1` 幂等：内核已在监听就直接退出，不会起第二个。

注册计划任务（登录时静默启动，不需要管理员权限）：

```powershell
$script = "<本目录>\scripts\start-gateway.ps1"
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "WorkBuddy Gateway Autostart" `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

日志写在 `%APPDATA%\codebuddy-gateway\autostart.log`。

移除：`Unregister-ScheduledTask -TaskName "WorkBuddy Gateway Autostart"`

## 运行时装在哪

插件不写死路径，按顺序找：

1. `%APPDATA%\codebuddy-gateway\panel-runtime.json` 里记的（上次找到的）
2. 环境变量 `CODEBUDDY_GATEWAY_ROOT`
3. 桌面版 `desktop.json` 的 `projectDir`（回溯两级）
4. 常见安装位
5. 本仓库 `release*/win-unpacked`

一个候选必须同时具备 `python`、`launcher.py` 和 `kernel/core/converter.py` 才算数。
找到后记进 `panel-runtime.json`。

## 踩过的坑

**`Config` 必须是 schemastery schema。** 写成普通对象会在装载时报
`Cannot read properties of undefined (reading 'validate')`，插件整个不激活。
没有配置项就别导出 `Config`。

**`package.json` 的 `files` 白名单必须包含 `cordis.patch.yml`。**
漏了的话 pnpm 打包时会把补丁文件丢掉，安装时报
`failed to read overlay ... ENOENT`。

**keyed 插槽要用 `key` 不是 `id`。** `sidebar.right.pane.tab` 是 keyed 槽，
键必须等于页签类型的 `id`。

**`guide` 条目的 `id` 是必填。**

**`.ps1` 存成 UTF-8 带 BOM。** PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，
中文全乱，脚本直接语法错误。

**改完源码要重装。** 安装目录是复制而不是软链，光改源码不生效。

## 已知限制

- 控制路由**没有额外鉴权**：它依赖 DSH web 自身的访问控制。若把 DSH 暴露到
  局域网，应自行加一层。
- 只能停本插件启动的内核；桌面版启动的会如实拒绝，不会误杀。
- `stop` 后 DSH 的模型调用会中断（网关是 DSH 的模型后端）。

## 许可

MIT
