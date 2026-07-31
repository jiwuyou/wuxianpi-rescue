const state = {
  plugins: [],
  selected: null,
  release: null,
  query: "",
  clientId: localStorage.getItem("wuxianpi-hub-client-id") || crypto.randomUUID()
};
localStorage.setItem("wuxianpi-hub-client-id", state.clientId);

const list = document.querySelector("#plugin-list");
const detail = document.querySelector("#detail");
const count = document.querySelector("#plugin-count");
const revision = document.querySelector("#revision");
const search = document.querySelector("#search");
const template = document.querySelector("#plugin-item-template");

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function filteredPlugins() {
  const query = state.query.trim().toLocaleLowerCase();
  if (!query) return state.plugins;
  return state.plugins.filter((plugin) => [plugin.id, plugin.name, plugin.description, plugin.category, ...plugin.tags]
    .some((value) => value.toLocaleLowerCase().includes(query)));
}

function renderList() {
  const plugins = filteredPlugins();
  count.textContent = String(plugins.length);
  list.replaceChildren();
  for (const plugin of plugins) {
    const fragment = template.content.cloneNode(true);
    const button = fragment.querySelector("button");
    button.classList.toggle("active", state.selected?.id === plugin.id);
    button.querySelector(".plugin-item-title").textContent = plugin.name;
    button.querySelector(".plugin-item-description").textContent = plugin.description;
    button.querySelector(".plugin-item-meta").textContent = `${plugin.category} · v${plugin.latestVersion}`;
    button.addEventListener("click", () => selectPlugin(plugin.id));
    list.append(fragment);
  }
}

function renderComment(comment) {
  const stars = comment.rating ? ` · ${"★".repeat(comment.rating)}` : "";
  return `
    <article class="comment ${comment.parentId ? "reply" : ""}">
      <div class="comment-head">
        <strong>${escapeHtml(comment.authorName)}</strong>
        <span class="author-type">${escapeHtml(comment.authorType)}</span>
        <span>v${escapeHtml(comment.version)}${stars}</span>
        <time>${new Date(comment.createdAt).toLocaleString()}</time>
      </div>
      <p>${escapeHtml(comment.content)}</p>
    </article>`;
}

async function loadComments() {
  const target = document.querySelector("#comments");
  if (!target || !state.selected || !state.release) return;
  try {
    const payload = await request(`/api/v1/plugins/${encodeURIComponent(state.selected.id)}/comments?version=${encodeURIComponent(state.release.manifest.version)}`);
    target.innerHTML = payload.comments.length ? payload.comments.map(renderComment).join("") : '<p class="checksum">当前版本还没有评论。</p>';
  } catch (error) {
    target.innerHTML = `<p class="status">${escapeHtml(error.message)}</p>`;
  }
}

function bindDocumentTabs() {
  const buttons = [...document.querySelectorAll("[data-document]")];
  const output = document.querySelector("#document");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      buttons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const document = state.release.documents.find((item) => item.path === button.dataset.document);
      output.textContent = document?.content || "";
    });
  }
}

function bindCommentForm() {
  const form = document.querySelector("#comment-form");
  const status = document.querySelector("#comment-status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "正在发布";
    const formData = new FormData(form);
    try {
      await request(`/api/v1/plugins/${encodeURIComponent(state.selected.id)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: state.release.manifest.version,
          authorType: formData.get("authorType"),
          authorName: formData.get("authorName"),
          clientId: state.clientId,
          content: formData.get("content"),
          rating: Number(formData.get("rating")) || null
        })
      });
      form.reset();
      status.textContent = "已发布";
      await loadComments();
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

function renderDetail() {
  const plugin = state.selected;
  const release = state.release;
  if (!plugin || !release) return;
  const manifest = release.manifest;
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(plugin.name)}</h2>
        <p>${escapeHtml(plugin.description)}</p>
      </div>
      <label class="version-box">版本
        <select id="version-select">
          ${plugin.versions.map((item) => `<option value="${escapeHtml(item.manifest.version)}" ${item.manifest.version === manifest.version ? "selected" : ""}>v${escapeHtml(item.manifest.version)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="meta-strip">
      <span class="tag accent">${escapeHtml(plugin.category)}</span>
      <span class="tag">Host ≥ ${manifest.minHostVersion}</span>
      ${manifest.requiredCapabilities.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
    </div>
    <section class="section">
      <h3>发布包</h3>
      <div class="download-row">
        <a class="primary" href="${escapeHtml(release.downloadUrl)}">下载 ZIP</a>
        <span>${Math.ceil(release.size / 1024)} KiB</span>
      </div>
      <p class="checksum">SHA-256 ${escapeHtml(release.sha256)}</p>
    </section>
    <section class="section">
      <h3>文档</h3>
      <div class="document-tabs">
        ${release.documents.map((item, index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-document="${escapeHtml(item.path)}">${escapeHtml(item.title)}</button>`).join("")}
      </div>
      <pre id="document" class="document">${escapeHtml(release.documents[0]?.content || "没有文档")}</pre>
    </section>
    <section class="section">
      <h3>评论与实测</h3>
      <div class="comment-layout">
        <div id="comments" class="comments"><p class="checksum">正在读取评论</p></div>
        <form id="comment-form" class="comment-form">
          <h4>发表评论</h4>
          <label>身份
            <select name="authorType"><option value="user">用户</option><option value="agent">Agent</option><option value="maintainer">维护者</option></select>
          </label>
          <label>名称<input name="authorName" maxlength="80" required></label>
          <label>评分
            <select name="rating"><option value="">不评分</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select>
          </label>
          <label>内容<textarea name="content" maxlength="4000" required></textarea></label>
          <button class="primary" type="submit">发布</button>
          <div id="comment-status" class="status"></div>
        </form>
      </div>
    </section>`;
  document.querySelector("#version-select").addEventListener("change", (event) => {
    state.release = plugin.versions.find((item) => item.manifest.version === event.target.value);
    renderDetail();
  });
  bindDocumentTabs();
  bindCommentForm();
  loadComments();
}

async function selectPlugin(id) {
  state.selected = state.plugins.find((plugin) => plugin.id === id);
  state.release = state.selected?.versions[0] || null;
  history.replaceState(null, "", `?plugin=${encodeURIComponent(id)}`);
  renderList();
  renderDetail();
}

async function initialize() {
  try {
    const payload = await request("/api/v1/plugins");
    state.plugins = payload.plugins;
    revision.textContent = `目录 ${payload.revision}`;
    renderList();
    const requested = new URLSearchParams(location.search).get("plugin");
    const initial = state.plugins.find((plugin) => plugin.id === requested) || state.plugins[0];
    if (initial) selectPlugin(initial.id);
  } catch (error) {
    revision.textContent = "连接失败";
    detail.innerHTML = `<div class="empty-state"><h2>无法读取插件市场</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

search.addEventListener("input", () => {
  state.query = search.value;
  renderList();
});
initialize();
