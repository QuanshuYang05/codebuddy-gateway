# 第三方组件与署名

本插件（`dsh-plugin/`）自身代码采用仓库根目录的 MIT License。
但它**在运行时组装并使用**第三方组件。这些组件的权利归各自作者所有。

---

## 1. 内核 `workbuddy2api`

| 项 | 内容 |
|---|---|
| 用途 | 协议转换、账号池、签到、用量账本（本插件通过 HTTP 调用它） |
| 许可 | **MIT License** |
| 版权 | Copyright © 2026 HanHan666666、Copyright © 2026 Chris |
| 来源 | 随「WorkBuddy 中转网关」桌面版分发；思路演进自 [HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai) |

### 本插件如何使用它

**不随本仓库分发内核源码。** `dsh-plugin/payload/kernel/` 被 `.gitignore` 排除，
它由 `scripts/build-payload.ps1` 从**使用者本机已安装的**网关里复制。

也就是说：本仓库不含内核代码，只在运行时调用用户本机的那一份。

> 若你要把组装后的 `payload/` 二次分发（例如做成 npm 包或安装程序），
> **必须一并保留内核自带的 `LICENSE`**（构建脚本会原样复制），
> 并在你的分发物里保留上述版权声明。

---

## 2. Python 运行时

| 项 | 内容 |
|---|---|
| 用途 | 运行内核（插件自带一份可重定位的 CPython） |
| 许可 | **PSF License Agreement**（Python Software Foundation） |
| 版权 | Copyright © 2001-2026 Python Software Foundation |

同样由 `scripts/build-payload.ps1` 从本机已安装的运行时复制，不进本仓库。
构建时会原样带上 `LICENSE.txt`。二次分发时请保留该文件。

---

## 3. 本插件新增的依赖

**没有。** `dsh-plugin/index.js` 与 `client.js` 只使用：

- Node.js 内置模块（`node:fs`、`node:path`、`node:os`、`node:crypto`、`node:child_process`、`node:url`）
- 宿主注入的 React（`require('react')`，由 DSH 的模块表提供）

前端不含任何第三方库，样式只用宿主的 `--dsw-alias-*` 主题变量。

---

## 4. 免责声明

本插件是对 WorkBuddy / CodeBuddy **本机登录态**的协议转换与界面封装：

- 不提供任何账号
- 不中转任何第三方密钥
- 所有请求均在本机完成

请遵守你与 WorkBuddy / CodeBuddy 之间的服务条款。因使用本插件产生的任何后果
由使用者自行承担。
