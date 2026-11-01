"""Build the distributable packages.

Three flavours, all sharing the same freshly compiled EXE:

  personal  - config.json included (real keys). Never hand this to anyone.
  share     - no config.json, uses the Node.js already installed on the machine.
  portable  - no config.json, bundles node.exe so nothing needs installing.

Every package carries an update.json pointing at the GitHub repo that the tray
"检查更新…" menu item queries. The EXE creates a blank config.json on first
launch, so the key-less packages boot into an empty WebUI instead of failing.

    python src/pack.py [--repo owner/name]
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

VERSION = "1.0.0"
DEFAULT_REPO = "lukeyancn/kimi-gateway"

NODE_CANDIDATES = [
    Path(r"C:\Program Files\nodejs\node.exe"),
    Path(r"C:\Program Files (x86)\nodejs\node.exe"),
]

# Everything the gateway needs at runtime. src/, build/, logs, metrics and
# backups stay out. The EXE is taken from build\ (the fresh compile), never
# from the repo root, which may still hold a locked older copy.
RUNTIME_FILES = [
    ("build/KimiGateway.exe", "KimiGateway.exe"),
    ("proxy.mjs", "proxy.mjs"),
    ("config.mjs", "config.mjs"),
    ("metrics.mjs", "metrics.mjs"),
    ("admin-api.mjs", "admin-api.mjs"),
    ("apply-kimi-settings.mjs", "apply-kimi-settings.mjs"),
    ("config.example.json", "config.example.json"),
    ("webui/index.html", "webui/index.html"),
    ("webui/style.css", "webui/style.css"),
    ("webui/app.js", "webui/app.js"),
    ("webui/favicon.svg", "webui/favicon.svg"),
]

INTRO = {
    "personal": """## 个人版

配置已随包附带（`config.json`，含 API Key），解压即可用，不用重新填 Key。

> ⚠ 这个包里有你自己的 API Key，只适合留在本机，不要发给别人。

""",
    "share": """## 分享版

不附带 `config.json`：第一次启动会自动生成一份空白配置，打开控制台后在 WebUI 里添加服务商、填 Key 即可。

**前提**：机器上已经安装 Node.js（<https://nodejs.org>）。程序会依次找同目录、`C:\\Program Files\\nodejs`、注册表和 `PATH` 里的 `node.exe`。

""",
    "portable": """## 绿色版

不附带 `config.json`：第一次启动会自动生成一份空白配置，打开控制台后在 WebUI 里添加服务商、填 Key 即可。

**已内置 Node.js**（包内 `node.exe`），目标机器不需要安装任何运行时，解压双击就能跑。内置运行时优先于系统安装的 Node。

""",
}


def read_version_sources():
    """Version lives in three places; they must agree."""
    proxy = (ROOT / "proxy.mjs").read_text(encoding="utf-8")
    proxy_version = re.search(r"const VERSION = '([^']+)'", proxy).group(1)

    cs = (ROOT / "src" / "KimiGateway.cs").read_text(encoding="utf-8")
    const_version = re.search(r'AppVersion = "([^"]+)"', cs).group(1)
    asm_version = re.search(r'AssemblyVersion\("([^"]+)"\)', cs).group(1)

    return {
        "proxy.mjs": proxy_version,
        "KimiGateway.cs AppVersion": const_version,
        "KimiGateway.cs AssemblyVersion": asm_version,
    }


def check_versions():
    versions = read_version_sources()
    for label, value in versions.items():
        print(f"  {label:<34} {value}")
    unique = {v.split(".")[0] + "." + ".".join(v.split(".")[1:3]) for v in versions.values()}
    if unique != {VERSION}:
        sys.exit(f"版本不一致：{versions}，pack.py 期望 {VERSION}")
    print(f"  版本一致 -> {VERSION}")


def build_exe():
    exe = ROOT / "build" / "KimiGateway.exe"
    print("== compiling KimiGateway.exe ==")
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "src" / "build.ps1")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="mbcs",
        errors="replace",
    )
    tail = [l for l in (result.stdout or "").splitlines() if l.strip()][-3:]
    for line in tail:
        print("  " + line)
    if not exe.exists():
        sys.exit("build/ 里没有生成 exe，编译失败")
    return exe


def stage(flavour, bundled_node, repo):
    tree = DIST / f"KimiGateway-{VERSION}-{flavour}"
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)

    for src, rel in RUNTIME_FILES:
        source = ROOT / src
        if not source.exists():
            sys.exit(f"缺少文件：{src}")
        target = tree / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    if flavour == "personal":
        shutil.copy2(ROOT / "config.json", tree / "config.json")

    if bundled_node is not None:
        shutil.copy2(bundled_node, tree / "node.exe")

    # 更新检查读这个文件：换仓库 / 换镜像不用重编译 exe。
    update = {
        "repo": repo,
        "assetHint": flavour,
        "apiBase": "https://api.github.com",
    }
    (tree / "update.json").write_text(json.dumps(update, indent=2) + "\n", encoding="utf-8")

    base_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    (tree / "README.md").write_text(INTRO[flavour] + base_readme, encoding="utf-8")
    return tree


def zip_tree(tree):
    archive = tree.parent / f"{tree.name}.zip"
    if archive.exists():
        archive.unlink()
    files = sorted(p for p in tree.rglob("*") if p.is_file())
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in files:
            z.write(path, f"{tree.name}/{path.relative_to(tree)}")
    return archive


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=DEFAULT_REPO, help="owner/name of the GitHub repo")
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()

    print("== version ==")
    check_versions()

    if not args.skip_build:
        build_exe()

    node = next((p for p in NODE_CANDIDATES if p.exists()), None)
    print(f"\n== node for the portable package: {node or 'NOT FOUND'} ==")

    flavours = [("personal", None), ("share", None), ("portable", node)]

    print()
    print(f"{'包':<40}{'文件数':>7}{'解压后':>12}{'zip':>12}")
    print("-" * 71)
    released = []
    for flavour, bundled in flavours:
        if flavour == "portable" and bundled is None:
            print("  跳过 portable：找不到 node.exe 可用于打包")
            continue
        tree = stage(flavour, bundled, args.repo)
        archive = zip_tree(tree)
        files = [p for p in tree.rglob("*") if p.is_file()]
        raw = sum(p.stat().st_size for p in files)
        print(f"{archive.name:<40}{len(files):>7}{raw / 1048576:>10.1f} MB{archive.stat().st_size / 1048576:>10.1f} MB")
        print(f"    sha256 {hashlib.sha256(archive.read_bytes()).hexdigest()}")
        if flavour != "personal":
            released.append(archive)

    print(f"\n仓库: {args.repo}   版本: v{VERSION}")
    print("可发布资产：")
    for archive in released:
        print(f"  {archive.name}")
    print("\n下一步：python src/publish.py --token <GITHUB_TOKEN>")


if __name__ == "__main__":
    main()
