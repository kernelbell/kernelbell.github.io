#!/usr/bin/env python3
import json
import os
import smtplib
import subprocess
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATCHES_FILE = ROOT / "patches.json"
STATE_FILE = ROOT / "state.json"
STATUS_FILE = ROOT / "docs" / "status.json"
CACHE_DIR = ROOT / ".kernelbell-cache"

MAINLINE_REPO = os.environ.get("KERNELBELL_MAINLINE_REPO") or "https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git"
STABLE_REPO = os.environ.get("KERNELBELL_STABLE_REPO") or "https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git"


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_json(path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def normalize_title(title):
    return " ".join(title.casefold().strip().split())


def patch_id(patch):
    if patch.get("id"):
        return patch["id"]
    normalized = normalize_title(patch["title"])
    return "".join(ch if ch.isalnum() else "-" for ch in normalized).strip("-")[:80]


def stable_branches_for(patch):
    raw = patch.get("stable_branches")
    if raw is None:
        raw = patch.get("stable_branch", [])
    if isinstance(raw, str):
        raw = [item.strip() for item in raw.split(",")]
    branches = []
    for branch in raw or []:
        branch = str(branch).strip()
        if branch and branch not in branches:
            branches.append(branch)
    return branches[:3], len(branches) > 3


def run_git(args, git_dir=None, check=True):
    cmd = ["git"]
    if git_dir:
        cmd.extend(["--git-dir", str(git_dir)])
    cmd.extend(args)
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(f"git command failed: {' '.join(cmd)}\n{proc.stderr.strip()}")
    return proc.stdout.strip()


def ensure_repo(name, url):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    repo = CACHE_DIR / f"{name}.git"
    if not repo.exists():
        subprocess.run(
            ["git", "clone", "--bare", "--filter=blob:none", "--no-tags", url, str(repo)],
            check=True,
        )
    else:
        run_git(["remote", "set-url", "origin", url], git_dir=repo)
    run_git(["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/heads/*"], git_dir=repo)
    return repo


def ref_exists(repo, ref):
    proc = subprocess.run(
        ["git", "--git-dir", str(repo), "rev-parse", "--verify", "--quiet", ref],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc.returncode == 0


def find_commit_by_title(repo, ref, title):
    if not ref_exists(repo, ref):
        return None
    output = run_git(
        [
            "log",
            ref,
            "--fixed-strings",
            "--regexp-ignore-case",
            f"--grep={title}",
            "--max-count=30",
            "--format=%H%x1f%s%x1f%ci%x1f%an",
        ],
        git_dir=repo,
        check=False,
    )
    target = normalize_title(title)
    for line in output.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 4:
            continue
        commit_hash, subject, committed_at, author = parts
        if normalize_title(subject) == target:
            return {
                "hash": commit_hash,
                "subject": subject,
                "committed_at": committed_at,
                "author": author,
                "ref": ref,
            }
    return None


def recipients_for(patch):
    recipients = patch.get("notify") or patch.get("notify_emails") or []
    if isinstance(recipients, str):
        recipients = [recipients]
    env_default = [item.strip() for item in os.environ.get("KERNELBELL_NOTIFY_TO", "").split(",") if item.strip()]
    return recipients or env_default


def smtp_enabled():
    return bool(os.environ.get("SMTP_HOST"))


def send_email(recipients, subject, body):
    if not recipients:
        print("No recipients configured; skip email")
        return False
    if not smtp_enabled():
        print("SMTP_HOST is not configured; skip email")
        return False

    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    sender = os.environ.get("SMTP_FROM") or username or "kernelbell@localhost"
    use_tls = os.environ.get("SMTP_TLS", "true").lower() not in {"0", "false", "no"}

    message = EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP(host, port, timeout=30) as server:
        if use_tls:
            server.starttls()
        if username and password:
            server.login(username, password)
        server.send_message(message)
    return True


def notify_if_new(patch, target, commit, state):
    if not commit:
        return False
    pid = patch_id(patch)
    notified = state.setdefault("notified", {}).setdefault(pid, {})
    if notified.get(target) == commit["hash"]:
        return False

    title = patch["title"]
    stable_branches, _ = stable_branches_for(patch)
    subject = f"[kernelbell] Patch merged in {target}: {title}"
    body = "\n".join(
        [
            f"Patch title: {title}",
            f"Target: {target}",
            f"Stable branches: {', '.join(stable_branches) or 'n/a'}",
            f"Commit: {commit['hash']}",
            f"Subject: {commit['subject']}",
            f"Author: {commit['author']}",
            f"Committed at: {commit['committed_at']}",
            "",
            "This notification was generated by kernelbell.",
        ]
    )
    if send_email(recipients_for(patch), subject, body):
        notified[target] = commit["hash"]
        notified[f"{target}_notified_at"] = now_iso()
        return True
    return False


def check_patches():
    patches = load_json(PATCHES_FILE, [])
    state = load_json(STATE_FILE, {"notified": {}})
    active_patches = [patch for patch in patches if patch.get("enabled", True) and patch.get("title", "").strip()]
    mainline_repo = ensure_repo("mainline", MAINLINE_REPO) if active_patches else None
    stable_repo = ensure_repo("stable", STABLE_REPO) if any(stable_branches_for(patch)[0] for patch in active_patches) else None

    results = []
    for patch in patches:
        pid = patch_id(patch)
        enabled = patch.get("enabled", True)
        title = patch.get("title", "").strip()
        stable_branches, too_many_stable_branches = stable_branches_for(patch)
        result = {
            "id": pid,
            "title": title,
            "stable_branches": stable_branches,
            "enabled": enabled,
            "last_checked_at": now_iso(),
            "mainline": {"found": False, "commit": None},
            "stable": {"found": False, "branches": []},
            "errors": [],
        }
        if too_many_stable_branches:
            result["errors"].append("only the first 3 stable branches are checked")

        if not enabled:
            results.append(result)
            continue
        if not title:
            result["errors"].append("title is required")
            results.append(result)
            continue

        try:
            mainline_commit = find_commit_by_title(mainline_repo, "master", title)
            if mainline_commit:
                result["mainline"] = {"found": True, "commit": mainline_commit}
                notify_if_new(patch, "mainline", mainline_commit, state)
        except Exception as exc:
            result["errors"].append(f"mainline check failed: {exc}")

        for stable_branch in stable_branches:
            branch_result = {"branch": stable_branch, "found": False, "commit": None}
            try:
                stable_commit = find_commit_by_title(stable_repo, stable_branch, title)
                if stable_commit:
                    branch_result = {"branch": stable_branch, "found": True, "commit": stable_commit}
                    result["stable"]["found"] = True
                    notify_if_new(patch, stable_branch, stable_commit, state)
            except Exception as exc:
                result["errors"].append(f"stable {stable_branch} check failed: {exc}")
            result["stable"]["branches"].append(branch_result)

        results.append(result)

    status = {"generated_at": now_iso(), "patches": results}
    write_json(STATE_FILE, state)
    write_json(STATUS_FILE, status)
    return status


def main():
    try:
        status = check_patches()
    except Exception as exc:
        print(f"kernelbell failed: {exc}", file=sys.stderr)
        return 1
    print(f"Checked {len(status['patches'])} patch(es) at {status['generated_at']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
