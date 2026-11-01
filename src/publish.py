"""Publish to GitHub: create the public repo, push the source, cut a release.

Auth: pass a token explicitly, or set GITHUB_TOKEN.

    python src/publish.py --token ghp_xxx
    python src/publish.py --token ghp_xxx --dry-run

The token needs `repo` scope (classic) or Contents + Administration read/write
(fine-grained). It is only used in-process; the git remote is written without
it, so nothing lands in .git/config.

Refuses to run if config.json (API keys) would be committed.
"""

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

VERSION = "1.1.0"
TAG = f"v{VERSION}"
RELEASE_NAME = f"Kimi 模型桥 v{VERSION}"
ASSETS = [
    f"KimiGateway-{VERSION}-portable.zip",
    f"KimiGateway-{VERSION}-share.zip",
]

NOTES_FILE = ROOT / "RELEASE_NOTES.md"


def release_notes():
    """优先用仓库根目录的 RELEASE_NOTES.md，方便改文案不用动代码。"""
    if NOTES_FILE.exists():
        return NOTES_FILE.read_text(encoding="utf-8").strip() + chr(10)
    return "Kimi 模型桥 v" + VERSION + chr(10)


FORBIDDEN_IN_GIT = ["config.json", "metrics.json"]


# --------------------------------------------------------------------- helpers

def api(method, path, token, payload=None, base="https://api.github.com"):
    url = base + path
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "KimiModelBridge-Publisher",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = {"message": body}
        return err.code, parsed


def upload_asset(token, upload_url, path, label=""):
    """POST one release asset. upload_url keeps its {...} template."""
    base = upload_url.split("{", 1)[0]
    query = urllib.parse.urlencode({"name": path.name, "label": label})
    data = path.read_bytes()
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    request = urllib.request.Request(
        f"{base}?{query}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": content_type,
            "Content-Length": str(len(data)),
            "User-Agent": "KimiModelBridge-Publisher",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.loads(response.read())


def run(cmd, **kwargs):
    # git 在中文 Windows 上会输出 GBK（甚至混合编码），按字节收再自行解码，
    # 避免 UnicodeDecodeError 把成功的命令判成失败。
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, **kwargs)
    stdout = (result.stdout or b"").decode("utf-8", "replace")
    stderr = (result.stderr or b"").decode("utf-8", "replace")
    if result.returncode != 0:
        print(stdout)
        print(stderr)
        raise RuntimeError(f"命令失败：{' '.join(cmd)}")
    return stdout.strip()


def git(*args):
    return run(["git", *args])


# ------------------------------------------------------------------ pre-flight

def ensure_git_repo():
    """git must exist before check-ignore can judge .gitignore."""
    if not (ROOT / ".git").exists():
        run(["git", "init", "-b", "main"])
        print("  已初始化 git 仓库")


def check_git_safety():
    """Nothing with a key may be committed."""
    problems = []
    for name in FORBIDDEN_IN_GIT:
        if (ROOT / name).exists():
            ignored = subprocess.run(
                ["git", "check-ignore", "-q", name], cwd=ROOT, capture_output=True
            ).returncode == 0
            if not ignored:
                problems.append(name)
    if problems:
        sys.exit(
            "这些文件会带着 API Key 进入公开仓库，先加进 .gitignore：\n  " + "\n  ".join(problems)
        )
    print("  git 安全：含密钥的文件已被忽略")


def prepare_repo(remote_url):
    ensure_git_repo()

    status = git("status", "--porcelain")
    if status:
        git("add", "-A")
        git("commit", "-m", f"Kimi 模型桥 v{VERSION}")
        print("  已提交")
    else:
        print("  工作区干净，跳过提交")

    existing = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True)
    if existing.returncode == 0:
        current = (existing.stdout or b"").decode("utf-8", "replace").strip()
        if current != remote_url:
            git("remote", "set-url", "origin", remote_url)
    else:
        git("remote", "add", "origin", remote_url)


def push(token, repo):
    """Push without leaking the token into .git/config."""
    url = f"https://x-access-token:{token}@github.com/{repo}.git"
    for branch in ("main", "master"):
        try:
            git("push", url, f"HEAD:refs/heads/{branch}", "--force")
            print(f"  已推送到 {branch}")
            return
        except RuntimeError:
            continue
    raise RuntimeError("推送失败")


# ------------------------------------------------------------------------ main

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", default=os.environ.get("GITHUB_TOKEN"))
    parser.add_argument("--repo", default="lukeyancn/kimi-gateway")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-push", action="store_true")
    args = parser.parse_args()

    print(f"== 发布 {TAG} -> {args.repo} ==\n")

    print("[1/5] 本地检查")
    ensure_git_repo()
    check_git_safety()
    missing = [a for a in ASSETS if not (DIST / a).exists()]
    if missing:
        sys.exit("缺少产物，先运行 python src/pack.py：\n  " + "\n  ".join(missing))
    for name in ASSETS:
        size = (DIST / name).stat().st_size
        print(f"  {name:<40}{size / 1048576:>8.1f} MB")

    if not args.token:
        print("\n没有 token。设置环境变量 GITHUB_TOKEN 或加 --token。")
        print("需要的权限：Contents + Administration 读写（细粒度），或 classic 的 repo。")
        return 2

    print("\n[2/5] 校验 token")
    status, user = api("GET", "/user", args.token)
    if status != 200:
        sys.exit(f"token 无效：HTTP {status} {user.get('message')}")
    login = user.get("login")
    print(f"  已登录：{login}")

    owner, name = args.repo.split("/", 1)
    if owner.lower() != login.lower():
        print(f"  注意：仓库属于 {owner}，token 属于 {login}，需要有该组织的写权限")

    if args.dry_run:
        print("\n--dry-run：跳过仓库创建、推送与发布")
        return 0

    print("\n[3/5] 仓库")
    status, repo = api("GET", f"/repos/{args.repo}", args.token)
    if status == 404:
        status, repo = api(
            "POST",
            "/user/repos",
            args.token,
            {
                "name": name,
                "description": "把 OpenAI 兼容模型接进 Kimi 的本地网关：托盘 EXE + WebUI + 用量统计",
                "private": False,
                "has_issues": True,
                "has_wiki": False,
                "auto_init": False,
            },
        )
        if status not in (200, 201):
            sys.exit(f"创建仓库失败：HTTP {status} {repo.get('message')}")
        print(f"  已创建公开仓库：{repo['html_url']}")
    elif status == 200:
        print(f"  仓库已存在：{repo['html_url']}")
    else:
        sys.exit(f"读取仓库失败：HTTP {status} {repo.get('message')}")

    if not args.skip_push:
        print("  推送源码…")
        prepare_repo(f"https://github.com/{args.repo}.git")
        push(args.token, args.repo)

    print("\n[4/5] 发布")
    status, existing = api("GET", f"/repos/{args.repo}/releases/tags/{TAG}", args.token)
    if status == 200:
        release = existing
        print(f"  {TAG} 已存在，复用（id={release['id']}）")
    else:
        status, release = api(
            "POST",
            f"/repos/{args.repo}/releases",
            args.token,
            {
                "tag_name": TAG,
                "target_commitish": "main",
                "name": RELEASE_NAME,
                "body": release_notes(),
                "draft": False,
                "prerelease": False,
            },
        )
        if status not in (200, 201):
            sys.exit(f"创建 release 失败：HTTP {status} {release.get('message')}")
        print(f"  已创建：{release['html_url']}")

    print("\n[5/5] 上传资产")
    for asset_name in ASSETS:
        path = DIST / asset_name
        assets = release.get("assets", [])
        if any(a["name"] == asset_name for a in assets):
            print(f"  {asset_name} 已存在，跳过")
            continue
        for attempt in range(3):
            try:
                uploaded = upload_asset(args.token, release["upload_url"], path)
                print(f"  上传 {asset_name} -> {uploaded['size'] / 1048576:.1f} MB")
                break
            except Exception as err:  # noqa: BLE001 - retry any transport error
                if attempt == 2:
                    sys.exit(f"  上传失败：{err}")
                time.sleep(3)

    status, verify = api("GET", f"/repos/{args.repo}/releases/latest", args.token)
    if status == 200:
        names = [a["name"] for a in verify.get("assets", [])]
        print(f"\n完成。latest = {verify['tag_name']}，资产：{', '.join(names) or '无'}")
        print(f"{verify['html_url']}")


if __name__ == "__main__":
    sys.exit(main() or 0)
