# 前置条件与安装诊断

**本插件自带运行时，装完即用。**

只要你本机**装过 WorkBuddy / CodeBuddy 并登录过**，装这个插件就能直接用，
不需要另外安装任何「中转网关」桌面版。

插件包里自带一份可重定位的 Python 与内核（18MB 压缩 / 54MB 解压），
首次点「启动」时自动完成初始化，然后你的账号就能用了。

---

## 一、它需要什么

| # | 依赖 | 谁提供 | 需要你做什么 |
|---|---|---|---|
| 1 | Python 运行时 | **插件自带** | 无 |
| 2 | 内核 | **插件自带** | 无 |
| 3 | 管理密钥 | 插件自动生成 | 无 |
| 4 | 客户端 API Key | 插件自动创建 | 无 |
| 5 | **CodeBuddy 登录态** | 本机 CodeBuddy 桌面端 | **登录过一次即可** |

**唯一需要你做的**：本机装过并登录过 WorkBuddy / CodeBuddy。
凭据在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`，
插件启动时会自动导入。

> ⚠️ 凭据必须由**登录产生**，没法打包分发。所以这一项省不掉 ——
> 但也只需你登录一次。

---

## 二、第一次使用

1. 装好插件，重启一次 `dsh web`
2. 打开右侧边栏 → 「中转网关」
3. 点 **「启动」**

插件会自动完成四件事：

```
[info] 使用插件自带运行时
[init] 已生成：管理密钥、凭据 ×1
[init] 跳过 1 份加密凭据（内核只认明文）
→ 内核已启动。已初始化：管理密钥、凭据 ×1。已创建客户端 API Key。
```

等几秒，KPI 和账号池就会出来。

**余额可能显示「同步中…」** —— 内核启动后要过几秒才向云端拉一次余额，
属正常，稍等即会刷出来。

---

## 三、检查自己的环境

点面板顶部的 **「体检」**，逐项列出：有没有、在哪、缺了怎么办、搜过哪些路径。

也可以直接问接口：

```bash
curl http://127.0.0.1:<DSH端口>/codebuddy-gateway/diagnose
```

---

## 四、逐项说明

### 1+2. Python 运行时与内核（插件自带）

插件按这个顺序找运行时：

1. **插件自带的 `payload/`** ← 正常情况走这里
2. `panel-runtime.json` 里记的（上次用过的）
3. 环境变量 `CODEBUDDY_GATEWAY_ROOT`
4. 本机已安装的「WorkBuddy 中转网关」（如果恰好装了）
5. 几个常见安装位

自带的那份排最前，因为它一定和当前插件版本匹配。体检里会明确写出来源：

```
✓ Python 运行时与内核 — 插件自带 · ...\node_modules\@local\codebuddy-gateway-panel\payload
```

**想用自己那份**（比如你要更新内核）：写一个
`%APPDATA%\codebuddy-gateway\panel-runtime.json`：

```json
{ "root": "D:\\your\\path\\codebuddy-gateway" }
```

> 注意：`panel-runtime.json` 优先级**低于**自带 payload。
> 要强制使用外部的，目前得删掉 `payload/` 目录。

### 3. 管理密钥

内核强制要求 admin key ≥20 字符，**且不会自动生成**。插件首次启动时自动生成。

手动创建：`%APPDATA%\codebuddy-gateway\keys.json`

```json
{ "adminKey": "至少二十位的随机字符串" }
```

> ⚠️ **这个文件不能带 UTF-8 BOM。** 内核用 `json.load` 读它，带 BOM 会解析失败，
> 而 `launcher.py` 的 `except` 会**静默回退成空值**，最后报成一句指向别处的
> `ADMIN_KEY must contain at least 20 characters`。
> 插件用无 BOM 写入，你手动改的话注意编辑器设置。

### 4. 客户端 API Key

内核对 `/v1/*` **强制校验**，缺了一律 401。插件首次启动时自动创建并写回
`desktop.json` 的 `clientKey`。

### 5. CodeBuddy 凭据 ⚠️

这是**唯一需要你参与**的一项。内核靠 `.info` 里的 `accessToken` 去
`www.codebuddy.cn` 换模型响应。

#### 加密的坑

**新版 CodeBuddy 桌面端会把令牌加密存储**，`accessToken` 变成一个对象：

```json
{ "auth": { "accessToken": { "$wbEncrypted": 1, "envelope": "..." } } }
```

内核只认**明文**。插件会自动**跳过**加密文件（并如实告诉你跳过了几份），
同目录里通常还有带时间戳的明文备份：

```
workbuddy-desktop.info                              ← 可能是加密的
workbuddy-desktop.2026-09-20T13-05-32-071Z.<...>.info   ← 明文，用这个
```

体检会逐个文件判断并告诉你哪几份能用：

```
✓ CodeBuddy 凭据 — 4 份可用（明文）· 位置 …\gateway-data\auth · 另有 2 份加密不可用
```

#### 三种拿到可用凭据的办法

1. **浏览器授权登录**（推荐）— 面板里「添加账号」，走系统浏览器完成一次
   OAuth，复用你已有的 CodeBuddy 会话。
2. **确认 CodeBuddy 桌面端已登录** — 它会写一份明文备份，插件下次启动自动导入。
3. **导入明文凭据** — 用同目录下带时间戳的那个 `.info`，通过面板「导入凭据」粘贴。

---

## 五、常见症状对照

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 面板显示「Host 半未加载（HTTP 404）」 | 插件刚装，宿主没重启 | 重启 `dsh web` |
| 「没有找到网关运行时」 | payload 损坏或缺失 | 重装插件；或写 `panel-runtime.json` |
| 「ADMIN_KEY must contain at least 20 characters」 | keys.json 缺失或带 BOM | 删掉 `keys.json` 让插件重新生成 |
| 客户端调 `/v1/*` 返回 401 | 没有客户端 Key | 面板点「启动」，插件会自动创建 |
| 「凭据缺少 accessToken」 | 用了加密的 .info | 用浏览器登录，或导入明文备份 |
| 账号出现但余额「同步中…」 | 内核正在拉余额 | 等几秒 |
| 「当前仅支持国内账号积分与签到」 | 账号域名是 `workbuddy.ai` | 签到与积分只支持国内账号 |
| 「这个内核不是本面板启动的」 | 有别的进程在管它 | 关掉那个进程，或从面板「重启」 |

---

## 六、为什么自带运行时

考虑过让用户自己装 Python（包只要 300KB），实测行不通：**大多数只有
WorkBuddy 的机器上根本没有可用的 Python**。即使有（比如 Miniconda），
`fastapi` / `uvicorn` / `httpx` 也全是缺的 —— 我实测过。

| 方案 | 用户要做什么 | 包体积 |
|---|---|---|
| **自带运行时（当前）** | 装插件 → 点启动 | 18 MB 压缩 / 54 MB 解压 |
| 用系统 Python | 需先装 Python + 三个依赖 | ~300 KB |
| 首次运行时下载 | 装插件 → 等下载（国内易失败） | ~300 KB |

18MB 换零配置，值得 —— 这也是唯一能让「只有 WorkBuddy 的用户」开箱即用的方案。

### 关于平台

当前 payload 是 **Windows x64** 的。macOS / Linux 需要各自的运行时，
要用的话得分别构建（见下）。

---

## 七、构建自己的 payload

要更新内置的内核版本，或为别的平台构建：

```powershell
pwsh -File scripts/build-payload.ps1 -Source <网关安装目录> -Force
```

脚本会复制运行时与内核（排除 `__pycache__` 与测试目录），然后**自检**：
真跑一次 `import fastapi,uvicorn,httpx`，并要求 `sys.prefix` 等于 payload
内的路径（证明可重定位）。不通过就直接失败，避免打出「只能在构建机跑」的包。

---

## 八、许可与署名

- 本插件（`index.js` / `client.js` / 脚本 / 文档）：MIT
- 随包分发的内核 `workbuddy2api`：**第三方 MIT 项目**，
  Copyright © 2026 HanHan666666、Copyright © 2026 Chris，
  思路演进自 [HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai)
- 随包分发的 Python 运行时：PSF License

内核自身的许可条款以内核目录下的 `LICENSE` 为准。
若你要二次分发本插件，请一并保留上述署名。
