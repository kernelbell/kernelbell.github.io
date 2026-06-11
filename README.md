# kernelbell.github.io

kernelbell tracks whether Linux kernel patches have landed in mainline and selected stable branches. It is designed to run entirely on GitHub Actions, with GitHub Pages as the small status and editing UI.

## How it works

- `patches.json` is the tracked patch list.
- `.github/workflows/monitor.yml` runs every 6 hours and can also be triggered manually.
- `scripts/monitor.py` reads commit metadata from the GitHub commits API, then matches commits by exact commit subject/title.
- No git clone or fetch is used; no source code is downloaded.
- `state.json` records which commits already triggered mail, so duplicate notifications are avoided.
- `docs/status.json` is generated for the GitHub Pages UI.
- `docs/` contains the GitHub Pages frontend.

## Patch list

Edit `patches.json` directly, or use the Pages UI after setting up an encrypted admin token.

```json
[
  {
    "id": "fix-important-bug",
    "title": "subsystem: fix important bug",
    "targets": ["mainline", "linux-5.10.y", "linux-6.6.y"],
    "notify": ["you@example.com"],
    "enabled": true
  }
]
```

The title is matched against the commit subject. Matching is case-insensitive, but the normalized subject must equal the normalized title.

Each patch uses `targets` to decide what to check. The Pages UI offers `mainline`, `linux-5.10.y`, and `linux-6.6.y`. Legacy `stable_branch` and `stable_branches` entries are still accepted.

## GitHub setup

1. Push this repository to GitHub.
2. Open repository settings and enable GitHub Pages from the `docs/` directory on the `main` branch.
3. Add SMTP secrets in `Settings -> Secrets and variables -> Actions`.
4. Run the `kernelbell` workflow manually once from the Actions tab.

Required mail secret:

- `SMTP_HOST`

Optional mail secrets:

- `SMTP_PORT`, default `587`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `SMTP_TLS`, default `true`
- `KERNELBELL_NOTIFY_TO`, comma-separated fallback recipients when a patch has no `notify`

Optional repository variables:

- `KERNELBELL_MAINLINE_GITHUB_REPO`, default `torvalds/linux`
- `KERNELBELL_STABLE_GITHUB_REPO`, default `gregkh/linux`
- `KERNELBELL_LOOKBACK_COMMITS`, default `1000`

## Frontend editing

The Pages UI loads `patches.json` through the GitHub Contents API to avoid raw CDN delay after edits. It can add and delete patches after you enter the admin password.

Admin token setup:

1. Create a fine-grained personal access token for this repository.
2. Grant `Contents: Read and write` and `Actions: Read and write`.
3. Open the Pages UI, enter an admin password, expand `Admin token setup`, paste the token, and click `Store encrypted token`.
4. Future edits only require the admin password.

The encrypted token is stored in `docs/admin.json`. The password is never committed, but the encrypted token file is public if this repository is public. Use a strong password and rotate the token if the password is shared.

The `Test mail` button triggers the `kernelbell` workflow in `test-mail` mode. It requires the admin password and sends a test message to the email field.

After editing the list, wait for the next scheduled workflow or trigger `kernelbell` manually.

## Local check

```bash
python3 scripts/monitor.py
```

The check uses GitHub commit metadata only. Increase `KERNELBELL_LOOKBACK_COMMITS` if you need to find older commits when adding an already-merged patch.
