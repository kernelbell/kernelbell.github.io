const els = {
  list: document.querySelector("#patch-list"),
  template: document.querySelector("#patch-template"),
  form: document.querySelector("#patch-form"),
  message: document.querySelector("#form-message"),
  token: document.querySelector("#token"),
  repoName: document.querySelector("#repo-name"),
  refresh: document.querySelector("#refresh"),
  saveToken: document.querySelector("#save-token"),
  total: document.querySelector("#total-count"),
  mainline: document.querySelector("#mainline-count"),
  stable: document.querySelector("#stable-count"),
  generated: document.querySelector("#generated-at"),
};

const AVAILABLE_TARGETS = ["mainline", "linux-5.10.y", "linux-6.6.y"];

let patches = [];
let status = { patches: [] };

function repoInfo() {
  const host = window.location.hostname;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (host.endsWith("github.io")) {
    const owner = host.replace(".github.io", "");
    return { owner, repo: parts[0] || `${owner}.github.io` };
  }
  return { owner: "", repo: "" };
}

function rawConfigUrl() {
  const { owner, repo } = repoInfo();
  if (!owner || !repo) return "../patches.json";
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/patches.json`;
}

function apiBase() {
  const { owner, repo } = repoInfo();
  if (!owner || !repo) throw new Error("Cannot infer GitHub repository from this URL");
  return `https://api.github.com/repos/${owner}/${repo}/contents/patches.json`;
}

function token() {
  return els.token.value.trim() || localStorage.getItem("kernelbell-token") || "";
}

function cacheKey() {
  const { owner, repo } = repoInfo();
  return `kernelbell-patches-${owner || "local"}-${repo || "preview"}`;
}

function readCachedPatches() {
  try {
    return JSON.parse(localStorage.getItem(cacheKey()) || "[]");
  } catch {
    return [];
  }
}

function cachePatches(nextPatches) {
  localStorage.setItem(cacheKey(), JSON.stringify(nextPatches));
}

function setMessage(text) {
  els.message.textContent = text;
}

function patchKey(patch) {
  return patch.id || patch.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function targetsFor(patch) {
  if (Array.isArray(patch.targets)) return [...new Set(patch.targets.map(String).filter(Boolean))];
  const targets = [];
  if (patch.mainline !== false) targets.push("mainline");
  stableBranches(patch).forEach((branch) => targets.push(branch));
  return [...new Set(targets)];
}

function stableBranches(patch) {
  if (Array.isArray(patch.targets)) return patch.targets.filter((target) => target !== "mainline").slice(0, 3);
  const raw = patch.stable_branches ?? patch.stable_branch ?? [];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(0, 3);
}

function stableStatusBranches(patch, state) {
  const configured = stableBranches(patch);
  if (Array.isArray(state?.stable?.branches)) {
    const byBranch = new Map(state.stable.branches.map((branch) => [branch.branch, branch]));
    return configured.map((branch) => byBranch.get(branch) || { branch, found: false, commit: null });
  }
  if (state?.stable) {
    return [{ branch: configured[0] || "stable", found: Boolean(state.stable.found), commit: state.stable.commit || null }];
  }
  return configured.map((branch) => ({ branch, found: false, commit: null }));
}

async function loadJson(path, fallback) {
  const response = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return fallback;
  return response.json();
}

function githubHeaders(requireToken = false) {
  const currentToken = token();
  if (requireToken && !currentToken) throw new Error("GitHub token is required for editing");
  const headers = { Accept: "application/vnd.github+json" };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  return headers;
}

function decodeContent(content) {
  return decodeURIComponent(escape(atob(content.replace(/\n/g, ""))));
}

async function getRemoteFile(requireToken = false) {
  const response = await fetch(apiBase(), { headers: githubHeaders(requireToken) });
  if (!response.ok) throw new Error(`GitHub API read failed: ${response.status}`);
  return response.json();
}

async function loadPatches() {
  try {
    const file = await getRemoteFile(false);
    return JSON.parse(decodeContent(file.content));
  } catch {
    return loadJson(rawConfigUrl(), []);
  }
}

async function loadData() {
  const cached = readCachedPatches();
  if (cached.length) {
    patches = cached;
    render();
  }
  const [nextPatches, nextStatus] = await Promise.all([
    loadPatches(),
    loadJson("status.json", { patches: [] }),
  ]);
  patches = nextPatches;
  status = nextStatus;
  cachePatches(patches);
  render();
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusFor(patch) {
  const id = patchKey(patch);
  return status.patches.find((item) => item.id === id || item.title === patch.title);
}

function badge(label, found, off) {
  const span = document.createElement("span");
  span.className = `badge ${found ? "found" : ""} ${off ? "off" : ""}`;
  span.textContent = label;
  return span;
}

function render() {
  const info = repoInfo();
  els.repoName.textContent = info.owner && info.repo ? `${info.owner}/${info.repo}` : "local preview";
  els.list.replaceChildren();

  const rows = patches.map((patch) => ({ patch, state: statusFor(patch) }));
  els.total.textContent = String(patches.length);
  els.mainline.textContent = String(rows.filter((row) => row.state?.mainline?.found).length);
  els.stable.textContent = String(rows.filter((row) => stableStatusBranches(row.patch, row.state).some((branch) => branch.found)).length);
  els.generated.textContent = formatDate(status.generated_at);

  if (!patches.length) {
    const empty = document.createElement("p");
    empty.className = "meta";
    empty.textContent = "No patches are tracked yet.";
    els.list.append(empty);
    return;
  }

  rows.forEach(({ patch, state }) => {
    const node = els.template.content.cloneNode(true);
    const card = node.querySelector(".patch-card");
    const targets = targetsFor(patch);
    const branches = stableBranches(patch);
    const stableRows = stableStatusBranches(patch, state);
    card.querySelector("h3").textContent = patch.title;
    card.querySelector(".meta").textContent = `${targets.join(", ") || "no targets"} - ${patch.enabled === false ? "disabled" : "enabled"}`;

    const badges = card.querySelector(".badges");
    if (targets.includes("mainline")) badges.append(badge("mainline", Boolean(state?.mainline?.found), false));
    stableRows.forEach((branch) => badges.append(badge(branch.branch, Boolean(branch.found), false)));
    if (patch.enabled === false) badges.append(badge("disabled", false, true));

    const commit = stableRows.find((branch) => branch.commit)?.commit || state?.mainline?.commit;
    card.querySelector(".commit").textContent = commit ? `${commit.hash}\n${commit.subject}\n${commit.committed_at}` : "Not found yet";
    card.querySelector(".delete-button").addEventListener("click", () => removePatch(patch));
    els.list.append(node);
  });
}

async function savePatches(nextPatches, message) {
  const current = await getRemoteFile(true);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(`${JSON.stringify(nextPatches, null, 2)}\n`))),
    sha: current.sha,
  };
  const response = await fetch(apiBase(), {
    method: "PUT",
    headers: {
      ...githubHeaders(true),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub API write failed: ${response.status}`);
  patches = nextPatches;
  cachePatches(patches);
  render();
}

async function addPatch(event) {
  event.preventDefault();
  const form = new FormData(els.form);
  const title = form.get("title").trim();
  const selectedTargets = form.getAll("targets").filter((target) => AVAILABLE_TARGETS.includes(target));
  const notify = form.get("notify").trim();
  if (!title) return;
  if (!selectedTargets.length) {
    setMessage("Select at least one target.");
    return;
  }
  const currentToken = token();
  const next = [
    ...patches,
    {
      id: patchKey({ title }),
      title,
      targets: selectedTargets,
      notify: notify ? [notify] : [],
      enabled: true,
    },
  ];
  setMessage("Saving patch...");
  try {
    await savePatches(next, `Track patch: ${title}`);
    els.form.reset();
    els.form.querySelector('[name="targets"][value="mainline"]').checked = true;
    els.form.querySelector('[name="targets"][value="linux-6.6.y"]').checked = true;
    els.token.value = currentToken;
    setMessage("Patch saved. Run the workflow or wait for the next schedule.");
  } catch (error) {
    setMessage(error.message);
  }
}

async function removePatch(patch) {
  setMessage("Removing patch...");
  try {
    const next = patches.filter((item) => patchKey(item) !== patchKey(patch));
    await savePatches(next, `Stop tracking patch: ${patch.title}`);
    setMessage("Patch removed.");
  } catch (error) {
    setMessage(error.message);
  }
}

els.form.addEventListener("submit", addPatch);
els.refresh.addEventListener("click", loadData);
els.saveToken.addEventListener("click", () => {
  localStorage.setItem("kernelbell-token", els.token.value.trim());
  setMessage("Token remembered in this browser.");
});

els.token.value = localStorage.getItem("kernelbell-token") || "";
loadData().catch((error) => setMessage(error.message));
