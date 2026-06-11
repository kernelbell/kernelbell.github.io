#!/usr/bin/env python3
import json
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
PATCHES_FILE = ROOT / "patches.json"
STATE_FILE = ROOT / "state.json"
STATUS_FILE = ROOT / "docs" / "status.json"

MAINLINE_GITHUB_REPO = os.environ.get("KERNELBELL_MAINLINE_GITHUB_REPO") or "torvalds/linux"
STABLE_GITHUB_REPO = os.environ.get("KERNELBELL_STABLE_GITHUB_REPO") or "gregkh/linux"
LOOKBACK_COMMITS = int(os.environ.get("KERNELBELL_LOOKBACK_COMMITS") or "1000")
GITHUB_TOKEN = os.environ.get("KERNELBELL_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
MAINLINE_TARGET = "mainline"


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


def targets_for(patch):
    raw = patch.get("targets")
    if raw is None:
        targets = []
        if patch.get("mainline", True):
            targets.append(MAINLINE_TARGET)
        targets.extend(stable_branches_for(patch)[0])
        return list(dict.fromkeys(targets))
    if isinstance(raw, str):
        raw = [item.strip() for item in raw.split(",")]
    targets = []
    for target in raw or []:
        target = str(target).strip()
        if target and target not in targets:
            targets.append(target)
    return targets


def stable_branches_for(patch):
    if patch.get("targets") is not None:
        branches = [target for target in targets_for({"targets": patch.get("targets")}) if target != MAINLINE_TARGET]
        return branches[:3], len(branches) > 3
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


def github_get(repo, path, query):
    url = f"https://api.github.com/repos/{repo}/{path}?{urlencode(query)}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "kernelbell",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API failed for {repo}/{path}: HTTP {exc.code} {details}") from exc
    except URLError as exc:
        raise RuntimeError(f"GitHub API failed for {repo}/{path}: {exc.reason}") from exc


def find_commit_by_title(repo, ref, title):
    target = normalize_title(title)
    per_page = 100
    pages = max(1, (LOOKBACK_COMMITS + per_page - 1) // per_page)
    checked = 0
    for page in range(1, pages + 1):
        commits = github_get(repo, "commits", {"sha": ref, "per_page": per_page, "page": page})
        if not commits:
            break
        for item in commits:
            checked += 1
            commit = item.get("commit", {})
            subject = commit.get("message", "").splitlines()[0]
            author = commit.get("author") or {}
            commit_hash = item.get("sha", "")
            committed_at = author.get("date", "")
            author_name = author.get("name", "")
            if checked > LOOKBACK_COMMITS:
                return None
            if normalize_title(subject) != target:
                continue
            return {
                "hash": commit_hash,
                "subject": subject,
                "committed_at": committed_at,
                "author": author_name,
                "ref": ref,
                "url": item.get("html_url"),
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
    targets = targets_for(patch)
    subject = f"[kernelbell] Patch merged in {target}: {title}"
    body = "\n".join(
        [
            f"Patch title: {title}",
            f"Target: {target}",
            f"Tracked targets: {', '.join(targets) or 'n/a'}",
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

    results = []
    for patch in patches:
        pid = patch_id(patch)
        enabled = patch.get("enabled", True)
        title = patch.get("title", "").strip()
        targets = targets_for(patch)
        mainline_enabled = MAINLINE_TARGET in targets
        stable_branches, too_many_stable_branches = stable_branches_for(patch)
        result = {
            "id": pid,
            "title": title,
            "targets": targets,
            "stable_branches": stable_branches,
            "enabled": enabled,
            "last_checked_at": now_iso(),
            "mainline": {"enabled": mainline_enabled, "found": False, "commit": None},
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

        if mainline_enabled:
            try:
                mainline_commit = find_commit_by_title(MAINLINE_GITHUB_REPO, "master", title)
                if mainline_commit:
                    result["mainline"] = {"enabled": True, "found": True, "commit": mainline_commit}
                    notify_if_new(patch, "mainline", mainline_commit, state)
            except Exception as exc:
                result["errors"].append(f"mainline check failed: {exc}")

        for stable_branch in stable_branches:
            branch_result = {"branch": stable_branch, "found": False, "commit": None}
            try:
                stable_commit = find_commit_by_title(STABLE_GITHUB_REPO, stable_branch, title)
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
