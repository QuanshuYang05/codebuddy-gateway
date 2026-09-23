"""桌面版启动器。

把 workbuddy2api 的管理应用（admin.server.create_app）跑在本地回环地址上。
与直接 `python -m admin.server` 的区别：

1. 绑定 127.0.0.1 而非 0.0.0.0 —— 桌面版只对本机提供服务。
2. secure_cookie=False —— 本地 HTTP 下 Secure Cookie 无法写入，管理端会登不上。
3. 数据目录落在用户目录，而不是 Linux 容器路径 /data/management。
4. 管理密钥从文件读取，由 Electron 侧生成与保管。
"""

import argparse
import json
import os
import pathlib
import sys

DEFAULT_PORT = 8787


def system_auth_dir() -> pathlib.Path:
    """桌面端 CodeBuddy 自己的凭据目录（只读来源，不往这里写）。"""
    home = pathlib.Path.home()
    if sys.platform == "win32":
        local = pathlib.Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return local / "CodeBuddyExtension" / "Data" / "Public" / "auth"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "CodeBuddyExtension" / "Data" / "Public" / "auth"
    xdg = pathlib.Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    return xdg / "CodeBuddyExtension" / "Data" / "Public" / "auth"


def pick_auth_dir(data_dir: pathlib.Path) -> str:
    """凭据目录：桌面版独占目录；首次启动从桌面端复制已有凭据过来。

    复制到自己的目录而不是直接指向系统目录，是为了避免管理后台把新账号
    写进桌面端 CodeBuddy 的目录里。
    """
    env = os.environ.get("CODEBUDDY_AUTH_DIR")
    if env:
        return env

    own = data_dir / "auth"
    own.mkdir(parents=True, exist_ok=True)

    if not any(own.glob("*.info")):
        src = system_auth_dir()
        if src.is_dir():
            import shutil

            copied = 0
            for f in sorted(src.glob("*.info")):
                try:
                    shutil.copy2(f, own / f.name)
                    copied += 1
                except OSError as exc:
                    sys.stderr.write(f"[launcher] 复制凭据失败 {f.name}: {exc}\n")
            if copied:
                sys.stderr.write(f"[launcher] 已从桌面端导入 {copied} 个凭据\n")

    return str(own)


def read_key_file(path: str | None, fallback: str = "") -> str:
    if not path or not os.path.exists(path):
        return fallback
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("adminKey", fallback)
    except (ValueError, OSError):
        return fallback


def main() -> None:
    ap = argparse.ArgumentParser(description="workbuddy2api 桌面版启动器")
    ap.add_argument("--project-dir", required=True, help="workbuddy2api 项目根目录")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--data-dir", required=True, help="桌面版数据目录")
    ap.add_argument("--auth-dir", default=None, help="覆盖凭据目录")
    ap.add_argument("--admin-key-file", default=None, help="保存管理密钥的 JSON 文件")
    ap.add_argument("--client-key", default="", help="客户端 API Key（首次迁入）")
    args = ap.parse_args()

    project = os.path.abspath(args.project_dir)
    if not os.path.isdir(project):
        sys.stderr.write(f"[launcher] 项目目录不存在: {project}\n")
        raise SystemExit(2)

    # admin.server 需要通过项目根目录 import core / admin
    sys.path.insert(0, project)
    os.chdir(project)

    data_dir = pathlib.Path(args.data_dir)
    management = data_dir / "management"
    management.mkdir(parents=True, exist_ok=True)

    auth_dir = args.auth_dir or pick_auth_dir(data_dir)
    admin_key = read_key_file(args.admin_key_file)

    sys.stderr.write(
        f"[launcher] project={project}\n"
        f"[launcher] data={data_dir}\n"
        f"[launcher] auth={auth_dir}\n"
        f"[launcher] admin_key={'已设置' if admin_key else '未设置'}\n"
    )

    try:
        from admin.server import create_app
    except ImportError as exc:
        sys.stderr.write(
            f"[launcher] 无法导入 admin.server（{exc}）。"
            f"请在项目目录内安装依赖：pip install -r requirements.txt\n"
        )
        raise SystemExit(3)

    app = create_app(
        root=str(management),
        auth_dir=auth_dir,
        initial_key=args.client_key,
        admin_key=admin_key,
        secure_cookie=False,
    )

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
