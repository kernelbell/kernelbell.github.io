#!/usr/bin/env python3
import json
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, urlencode
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
    return github_get_url(url)


def github_get_url(url):
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
        raise RuntimeError(f"GitHub API failed for {url}: HTTP {exc.code} {details}") from exc
    except URLError as exc:
        raise RuntimeError(f"GitHub API failed for {url}: {exc.reason}") from exc


def commit_from_item(item, ref, match_type):
    commit = item.get("commit", {})
    subject = commit.get("message", "").splitlines()[0]
    author = commit.get("author") or {}
    return {
        "hash": item.get("sha", ""),
        "subject": subject,
        "committed_at": author.get("date", ""),
        "author": author.get("name", ""),
        "ref": ref,
        "url": item.get("html_url"),
        "match_type": match_type,
    }


def title_matches(subject, title):
    normalized_subject = normalize_title(subject)
    normalized_title = normalize_title(title)
    if normalized_subject == normalized_title:
        return "exact"
    if normalized_subject.endswith(f": {normalized_title}"):
        return "suffix-after-prefix"
    if normalized_subject.endswith(normalized_title):
        return "suffix"
    return None


def search_commits_by_title(repo, ref, title):
    terms = " ".join(normalize_title(title).split()[:8])
    if not terms:
        return None
    query = f"repo:{repo} {terms}"
    url = f"https://api.github.com/search/commits?q={quote_plus(query)}&per_page=20"
    data = github_get_url(url)
    items = data.get("items", [])
    print(f"    search: query={query!r}, results={data.get('total_count', 0)}, checked={len(items)}")
    fallback = None
    for item in items:
        commit = commit_from_item(item, ref, "search")
        match_type = title_matches(commit["subject"], title)
        if match_type:
            commit["match_type"] = f"search-{match_type}"
            return commit
        if fallback is None and normalize_title(title) in normalize_title(item.get("commit", {}).get("message", "")):
            fallback = commit
            fallback["match_type"] = "search-message-contains"
    return fallback


def find_commit_by_title(repo, ref, title):
    if repo == MAINLINE_GITHUB_REPO and ref == "master":
        search_commit = search_commits_by_title(repo, ref, title)
        if search_commit:
            return search_commit

    target = normalize_title(title)
    per_page = 100
    pages = max(1, (LOOKBACK_COMMITS + per_page - 1) // per_page)
    checked = 0
    latest_subjects = []
    for page in range(1, pages + 1):
        commits = github_get(repo, "commits", {"sha": ref, "per_page": per_page, "page": page})
        if not commits:
            break
        for item in commits:
            checked += 1
            commit = commit_from_item(item, ref, "list")
            subject = commit["subject"]
            if len(latest_subjects) < 5:
                latest_subjects.append(subject)
            if checked > LOOKBACK_COMMITS:
                print(f"    list: checked={checked - 1}, limit={LOOKBACK_COMMITS}, no match")
                if latest_subjects:
                    print("    latest subjects:")
                    for latest in latest_subjects:
                        print(f"      - {latest}")
                return None
            match_type = title_matches(subject, title)
            if not match_type:
                continue
            commit["match_type"] = f"list-{match_type}"
            print(f"    list: checked={checked}, matched={match_type}")
            return commit
    print(f"    list: checked={checked}, no match")
    if latest_subjects:
        print("    latest subjects:")
        for latest in latest_subjects:
            print(f"      - {latest}")
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
    port = int(os.environ.get("SMTP_PORT") or "587")
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


def send_test_email(recipient):
    recipients = [recipient.strip()] if recipient and recipient.strip() else recipients_for({})
    subject = "[kernelbell] Mail test"
    body = "\n".join(
        [
            "This is a kernelbell mail test.",
            f"Generated at: {now_iso()}",
            "",
            "If you received this message, SMTP notification is working.",
        ]
    )
    if send_email(recipients, subject, body):
        print(f"Sent test email to {', '.join(recipients)}")
        return 0
    return 1


def notify_if_new(patch, target, commit, state):
    if not commit:
        return "not-found"
    pid = patch_id(patch)
    notified = state.setdefault("notified", {}).setdefault(pid, {})
    if notified.get(target) == commit["hash"]:
        return "already-notified"

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
        return "sent"
    return "send-skipped-or-failed"


def check_patches():
    patches = load_json(PATCHES_FILE, [])
    state = load_json(STATE_FILE, {"notified": {}})

    print(f"kernelbell: loaded {len(patches)} patch(es), lookback={LOOKBACK_COMMITS}")
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

        print(f"\npatch: {pid}")
        print(f"  title: {title or '<missing>'}")
        print(f"  enabled: {enabled}")
        print(f"  targets: {', '.join(targets) or '<none>'}")
        print(f"  notify: {', '.join(recipients_for(patch)) or '<none>'}")

        if not enabled:
            print("  skip: patch disabled")
            results.append(result)
            continue
        if not title:
            print("  skip: title missing")
            result["errors"].append("title is required")
            results.append(result)
            continue

        if mainline_enabled:
            try:
                print(f"  checking mainline: repo={MAINLINE_GITHUB_REPO}, ref=master")
                mainline_commit = find_commit_by_title(MAINLINE_GITHUB_REPO, "master", title)
                if mainline_commit:
                    result["mainline"] = {"enabled": True, "found": True, "commit": mainline_commit}
                    notify_result = notify_if_new(patch, "mainline", mainline_commit, state)
                    print(f"  mainline: FOUND {mainline_commit['hash'][:12]} ({mainline_commit.get('match_type')})")
                    print(f"  mainline: subject={mainline_commit['subject']}")
                    print(f"  mainline: notify={notify_result}")
                else:
                    print("  mainline: not found")
            except Exception as exc:
                result["errors"].append(f"mainline check failed: {exc}")
                print(f"  mainline: ERROR {exc}")

        for stable_branch in stable_branches:
            branch_result = {"branch": stable_branch, "found": False, "commit": None}
            try:
                print(f"  checking stable: repo={STABLE_GITHUB_REPO}, ref={stable_branch}")
                stable_commit = find_commit_by_title(STABLE_GITHUB_REPO, stable_branch, title)
                if stable_commit:
                    branch_result = {"branch": stable_branch, "found": True, "commit": stable_commit}
                    result["stable"]["found"] = True
                    notify_result = notify_if_new(patch, stable_branch, stable_commit, state)
                    print(f"  stable {stable_branch}: FOUND {stable_commit['hash'][:12]} ({stable_commit.get('match_type')})")
                    print(f"  stable {stable_branch}: subject={stable_commit['subject']}")
                    print(f"  stable {stable_branch}: notify={notify_result}")
                else:
                    print(f"  stable {stable_branch}: not found")
            except Exception as exc:
                result["errors"].append(f"stable {stable_branch} check failed: {exc}")
                print(f"  stable {stable_branch}: ERROR {exc}")
            result["stable"]["branches"].append(branch_result)

        results.append(result)

    status = {"generated_at": now_iso(), "patches": results}
    write_json(STATE_FILE, state)
    write_json(STATUS_FILE, status)
    return status


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--test-mail":
        recipient = sys.argv[2] if len(sys.argv) >= 3 else ""
        return send_test_email(recipient)
    try:
        status = check_patches()
    except Exception as exc:
        print(f"kernelbell failed: {exc}", file=sys.stderr)
        return 1
    print(f"Checked {len(status['patches'])} patch(es) at {status['generated_at']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
