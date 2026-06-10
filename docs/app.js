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

function setMessage(text) {
  els.message.textContent = text;
}

function patchKey(patch) {
  return patch.id || patch.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function loadJson(path, fallback) {
  const response = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return fallback;
  return response.json();
}

async function loadData() {
  patches = await loadJson(rawConfigUrl(), []);
  status = await loadJson("status.json", { patches: [] });
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
  els.stable.textContent = String(rows.filter((row) => row.state?.stable?.found).length);
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
    card.querySelector("h3").textContent = patch.title;
    card.querySelector(".meta").textContent = `${patch.stable_branch || "no stable branch"} - ${patch.enabled === false ? "disabled" : "enabled"}`;

    const badges = card.querySelector(".badges");
    badges.append(badge("mainline", Boolean(state?.mainline?.found), false));
    badges.append(badge(patch.stable_branch || "stable", Boolean(state?.stable?.found), false));
    if (patch.enabled === false) badges.append(badge("disabled", false, true));

    const commit = state?.stable?.commit || state?.mainline?.commit;
    card.querySelector(".commit").textContent = commit ? `${commit.hash}\n${commit.subject}\n${commit.committed_at}` : "Not found yet";
    card.querySelector(".delete-button").addEventListener("click", () => removePatch(patch));
    els.list.append(node);
  });
}

async function getRemoteFile() {
  const currentToken = token();
  if (!currentToken) throw new Error("GitHub token is required for editing");
  const response = await fetch(apiBase(), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${currentToken}`,
    },
  });
  if (!response.ok) throw new Error(`GitHub API read failed: ${response.status}`);
  return response.json();
}

async function savePatches(nextPatches, message) {
  const current = await getRemoteFile();
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(`${JSON.stringify(nextPatches, null, 2)}\n`))),
    sha: current.sha,
  };
  const response = await fetch(apiBase(), {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub API write failed: ${response.status}`);
  patches = nextPatches;
  render();
}

async function addPatch(event) {
  event.preventDefault();
  const form = new FormData(els.form);
  const title = form.get("title").trim();
  const stableBranch = form.get("stable_branch").trim();
  const notify = form.get("notify").trim();
  if (!title) return;
  const next = [
    ...patches,
    {
      id: patchKey({ title }),
      title,
      stable_branch: stableBranch,
      notify: notify ? [notify] : [],
      enabled: true,
    },
  ];
  setMessage("Saving patch...");
  try {
    await savePatches(next, `Track patch: ${title}`);
    els.form.reset();
    els.token.value = token();
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
