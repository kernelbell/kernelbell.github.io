const els = {
  list: document.querySelector("#patch-list"),
  template: document.querySelector("#patch-template"),
  form: document.querySelector("#patch-form"),
  message: document.querySelector("#form-message"),
  adminPassword: document.querySelector("#admin-password"),
  setupToken: document.querySelector("#setup-token"),
  storeAdmin: document.querySelector("#store-admin"),
  testMail: document.querySelector("#test-mail"),
  rememberEmail: document.querySelector("#remember-email"),
  notify: document.querySelector("#notify"),
  repoName: document.querySelector("#repo-name"),
  refresh: document.querySelector("#refresh"),
  total: document.querySelector("#total-count"),
  mainline: document.querySelector("#mainline-count"),
  stable: document.querySelector("#stable-count"),
  generated: document.querySelector("#generated-at"),
};

const AVAILABLE_TARGETS = ["mainline", "linux-5.10.y", "linux-6.6.y"];
const ADMIN_FILE = "docs/admin.json";
const TOKEN_ITERATIONS = 160000;

let patches = [];
let status = { patches: [] };
let unlockedToken = "";

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
  return contentApiUrl("patches.json");
}

function contentApiUrl(path) {
  const { owner, repo } = repoInfo();
  if (!owner || !repo) throw new Error("Cannot infer GitHub repository from this URL");
  return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
}

function token() {
  return unlockedToken;
}

function cacheKey() {
  const { owner, repo } = repoInfo();
  return `kernelbell-patches-${owner || "local"}-${repo || "preview"}`;
}

function emailKey() {
  const { owner, repo } = repoInfo();
  return `kernelbell-email-${owner || "local"}-${repo || "preview"}`;
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

function rememberedEmail() {
  return localStorage.getItem(emailKey()) || "";
}

function rememberEmail() {
  const email = els.notify.value.trim();
  if (!email) {
    setMessage("Enter an email address first.");
    return;
  }
  localStorage.setItem(emailKey(), email);
  setMessage("Email remembered in this browser.");
}

function setMessage(text) {
  els.message.textContent = text;
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function tokenKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptToken(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await tokenKey(password, salt, TOKEN_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: TOKEN_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

async function decryptToken(config, password) {
  const key = await tokenKey(password, base64ToBytes(config.salt), config.iterations || TOKEN_ITERATIONS);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(config.iv) }, key, base64ToBytes(config.ciphertext));
  return new TextDecoder().decode(plaintext);
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

function githubHeadersWith(currentToken) {
  const headers = { Accept: "application/vnd.github+json" };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  return headers;
}

async function githubHeaders(requireToken = false) {
  const currentToken = requireToken ? await adminToken() : token();
  if (requireToken && !currentToken) throw new Error("Admin password is required for editing");
  return githubHeadersWith(currentToken);
}

function decodeContent(content) {
  return decodeURIComponent(escape(atob(content.replace(/\n/g, ""))));
}

async function getRemoteFile(requireToken = false) {
  const response = await fetch(apiBase(), { headers: await githubHeaders(requireToken) });
  if (!response.ok) throw new Error(`GitHub API read failed: ${response.status}`);
  return response.json();
}

async function readContent(path, authToken = "") {
  const response = await fetch(`${contentApiUrl(path)}?t=${Date.now()}`, { headers: githubHeadersWith(authToken) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API read failed: ${response.status}`);
  return response.json();
}

async function writeContent(path, value, message, authToken) {
  const current = await readContent(path, authToken);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(`${JSON.stringify(value, null, 2)}\n`))),
  };
  if (current?.sha) body.sha = current.sha;
  const response = await fetch(contentApiUrl(path), {
    method: "PUT",
    headers: {
      ...githubHeadersWith(authToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub API write failed: ${response.status}`);
  return response.json();
}

async function adminToken() {
  if (unlockedToken) return unlockedToken;
  const password = els.adminPassword.value.trim();
  if (!password) throw new Error("Admin password is required.");
  let config = null;
  try {
    const file = await readContent(ADMIN_FILE);
    config = file ? JSON.parse(decodeContent(file.content)) : null;
  } catch {
    config = await loadJson("admin.json", null);
  }
  if (!config) throw new Error("Admin token is not set up yet.");
  try {
    unlockedToken = await decryptToken(config, password);
    return unlockedToken;
  } catch {
    throw new Error("Admin password is incorrect.");
  }
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
  const authToken = await adminToken();
  const current = await getRemoteFile(true);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(`${JSON.stringify(nextPatches, null, 2)}\n`))),
    sha: current.sha,
  };
  const response = await fetch(apiBase(), {
    method: "PUT",
    headers: {
      ...githubHeadersWith(authToken),
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
    if (notify) localStorage.setItem(emailKey(), notify);
    await savePatches(next, `Track patch: ${title}`);
    els.form.reset();
    els.notify.value = rememberedEmail();
    els.form.querySelector('[name="targets"][value="mainline"]').checked = true;
    els.form.querySelector('[name="targets"][value="linux-6.6.y"]').checked = true;
    setMessage("Patch saved. Run the workflow or wait for the next schedule.");
  } catch (error) {
    setMessage(error.message);
  }
}

async function storeAdminToken() {
  const setupToken = els.setupToken.value.trim();
  const password = els.adminPassword.value.trim();
  if (!setupToken || !password) {
    setMessage("Setup token and admin password are required.");
    return;
  }
  setMessage("Encrypting admin token...");
  try {
    const encrypted = await encryptToken(setupToken, password);
    await writeContent(ADMIN_FILE, encrypted, "Store encrypted kernelbell admin token", setupToken);
    unlockedToken = setupToken;
    els.setupToken.value = "";
    setMessage("Encrypted admin token stored. Future edits only need the password.");
  } catch (error) {
    setMessage(error.message);
  }
}

async function testMail() {
  const form = new FormData(els.form);
  const testEmail = form.get("notify").trim();
  if (!testEmail) {
    setMessage("Enter an email address first.");
    return;
  }
  const { owner, repo } = repoInfo();
  localStorage.setItem(emailKey(), testEmail);
  setMessage("Triggering mail test workflow...");
  try {
    const authToken = await adminToken();
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/monitor.yml/dispatches`, {
      method: "POST",
      headers: {
        ...githubHeadersWith(authToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { mode: "test-mail", test_email: testEmail } }),
    });
    if (!response.ok) throw new Error(`Workflow dispatch failed: ${response.status}`);
    setMessage("Mail test workflow started. Check Actions for the result.");
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
els.storeAdmin.addEventListener("click", storeAdminToken);
els.testMail.addEventListener("click", testMail);
els.rememberEmail.addEventListener("click", rememberEmail);
els.adminPassword.addEventListener("input", () => {
  unlockedToken = "";
});

els.notify.value = rememberedEmail();
loadData().catch((error) => setMessage(error.message));
