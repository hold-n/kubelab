// kubelab course viewer: renders the repo's Markdown lessons and files, with a web terminal.
const $ = (s, el = document) => el.querySelector(s);
const content = $("#content");
const DONE_KEY = "kubelab.done";
const done = new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));
let nav = [];

// ------------------------------------------------------------------ helpers
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const resolvePath = (base, rel) => decodeURIComponent(new URL(rel, "http://x/" + base).pathname.slice(1));
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
const LANG_BY_EXT = { yaml: "yaml", yml: "yaml", sh: "bash", py: "python", mjs: "javascript", js: "javascript", json: "json", tpl: "go", txt: "plaintext", md: "markdown", css: "css", html: "xml" };

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------ navigation
async function loadNav() {
  nav = await (await fetch("/api/nav")).json();
  renderNav();
}

function renderNav(current) {
  $("#sidebar").innerHTML = nav
    .map((n) => `<a href="#/${n.path}" data-path="${n.path}" class="${n.path === current ? "current" : ""} ${done.has(n.path) ? "done" : ""}">
        <span class="num">${n.num}</span><span>${escapeHtml(n.title)}</span></a>`)
    .join("");
}

function currentRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  return h || "README.md";
}

async function route() {
  const p = currentRoute();
  renderNav(p);
  $("#content-wrap").scrollTop = 0;
  try {
    if (p.endsWith("/")) await renderDir(p);
    else if (p.endsWith(".md")) await renderMarkdown(p);
    else await renderFile(p).catch(() => renderDir(p + "/")); // e.g. a link to "kustomize/base"
  } catch (e) {
    content.innerHTML = `<h1>Not found</h1><p><code>${escapeHtml(p)}</code> doesn't exist.</p><p><a href="#/README.md">Back to the start</a></p>`;
  }
}

async function fetchText(p) {
  const r = await fetch("/repo/" + p.split("/").map(encodeURIComponent).join("/"));
  if (!r.ok) throw new Error(r.status);
  return r.text();
}

function breadcrumb(p) {
  const parts = p.split("/").filter(Boolean);
  let acc = "";
  const crumbs = parts.slice(0, -1).map((seg) => {
    acc += seg + "/";
    const readme = nav.find((n) => n.path === acc + "README.md");
    return `<a href="#/${readme ? readme.path : acc}">${escapeHtml(seg)}</a>`;
  });
  return `<div class="breadcrumb"><a href="#/README.md">kubelab</a> / ${crumbs.join(" / ")}${crumbs.length ? " / " : ""}${escapeHtml(parts.at(-1) || "")}</div>`;
}

// ------------------------------------------------------------------ renderers
async function renderMarkdown(p) {
  const md = await fetchText(p);
  content.innerHTML = marked.parse(md, { gfm: true });
  enhance(p);
  const h1 = $("h1", content);
  document.title = (h1 ? h1.textContent + " · " : "") + "kubelab";
  appendPager(p);
}

async function renderFile(p) {
  const text = await fetchText(p);
  const ext = p.split(".").pop();
  const lang = LANG_BY_EXT[ext] || (p.endsWith("Dockerfile") ? "dockerfile" : "plaintext");
  content.innerHTML = `${breadcrumb(p)}<div class="file-header"><h1>${escapeHtml(p.split("/").pop())}</h1></div>
    <pre><code class="language-${lang}">${escapeHtml(text)}</code></pre>`;
  enhance(p);
  document.title = p.split("/").pop() + " · kubelab";
}

async function renderDir(p) {
  const files = await (await fetch("/api/ls?path=" + encodeURIComponent(p))).json();
  content.innerHTML = `${breadcrumb(p)}<h1>${escapeHtml(p)}</h1><ul class="listing">${files
    .map((f) => `<li><a href="#/${p}${f}">${f.endsWith("/") ? "📁" : "📄"} ${escapeHtml(f)}</a></li>`)
    .join("")}</ul>`;
  document.title = p + " · kubelab";
}

// Rewrite links, add heading anchors, highlight code, add copy / paste-to-terminal buttons.
function enhance(p) {
  const base = dirOf(p);
  content.querySelectorAll("h1, h2, h3, h4").forEach((h) => (h.id = slug(h.textContent)));
  content.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (/^(https?:|mailto:)/.test(href)) {
      a.target = "_blank";
      a.rel = "noopener";
    } else if (href.startsWith("#")) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
      });
    } else if (!href.startsWith("#/")) {
      a.setAttribute("href", "#/" + resolvePath(base, href.split("#")[0]));
    }
  });
  content.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-(\S+)/) || [])[1];
    const text = code.textContent;
    const isDiagram = !lang && /[─│┌┐└┘▶◀▼▲]/.test(text);
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);

    const wrap = document.createElement("div");
    wrap.className = "codeblock" + (isDiagram ? " diagram" : "");
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const actions = document.createElement("div");
    actions.className = "actions";
    wrap.appendChild(actions);

    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      toast("Copied");
    };
    actions.appendChild(copy);
    if (["bash", "sh", "shell", "console"].includes(lang)) {
      const run = document.createElement("button");
      run.className = "run";
      run.textContent = "▶ Paste in terminal";
      run.title = "Paste into the terminal (press Enter there to run it)";
      run.onclick = () => pasteToTerminal(text.replace(/\n+$/, ""));
      actions.prepend(run);
    }
  });
}

function appendPager(p) {
  const i = nav.findIndex((n) => n.path === p);
  if (i < 0) return;
  const prev = nav[i - 1], next = nav[i + 1];
  const el = document.createElement("div");
  el.className = "pager";
  el.innerHTML = `<span>${prev ? `<a href="#/${prev.path}">← ${escapeHtml(prev.title)}</a>` : ""}</span>
    ${i > 0 ? `<label><input type="checkbox" ${done.has(p) ? "checked" : ""}> Mark lesson complete</label>` : ""}
    <span>${next ? `<a href="#/${next.path}">${escapeHtml(next.title)} →</a>` : ""}</span>`;
  el.querySelector("input")?.addEventListener("change", (e) => {
    e.target.checked ? done.add(p) : done.delete(p);
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
    renderNav(p);
  });
  content.appendChild(el);
}

// ------------------------------------------------------------------ terminal
const pane = $("#terminal-pane"), resizer = $("#resizer"), iframe = $("#terminal");

function setTerminal(open) {
  pane.hidden = resizer.hidden = !open;
  $("#terminal-btn").classList.toggle("active", open);
  localStorage.setItem("kubelab.terminal", open ? "1" : "0");
  if (open && !iframe.src) iframe.src = "/terminal/";
  if (open) setTimeout(() => iframe.contentWindow?.focus(), 100);
}

async function pasteToTerminal(text) {
  const wasClosed = pane.hidden;
  setTerminal(true);
  // A freshly opened terminal needs a moment before its tmux session exists.
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await fetch("/api/paste", { method: "POST", body: text });
    if (r.ok) {
      iframe.contentWindow?.focus();
      return toast("Pasted: press Enter in the terminal to run it");
    }
    if (r.status === 403) return toast("The terminal is only available to this thread's collaborators");
    await new Promise((res) => setTimeout(res, wasClosed ? 500 : 250));
  }
  toast("Couldn't reach the terminal. Try reopening it.");
}

$("#terminal-btn").onclick = () => setTerminal(pane.hidden);
$("#terminal-reload").onclick = () => (iframe.src = "/terminal/");
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setTerminal(pane.hidden);
  }
});
resizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
  resizer.classList.add("dragging");
  const move = (ev) => {
    const w = Math.min(Math.max(window.innerWidth - ev.clientX, 320), window.innerWidth - 400);
    pane.style.width = w + "px";
  };
  const up = () => {
    document.body.classList.remove("dragging");
    resizer.classList.remove("dragging");
    localStorage.setItem("kubelab.terminalWidth", pane.style.width);
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

// ------------------------------------------------------------------ tool UIs menu
const menu = $("#tools-menu");
async function refreshTools() {
  try {
    const tools = await (await fetch("/api/tools")).json();
    menu.innerHTML = tools.length
      ? tools.map((t) => `<a href="${t.url}" target="_blank" rel="noopener"><span class="dot ${t.up ? "up" : ""}"></span>
          <span><b>${escapeHtml(t.name)}</b> <small>${t.up ? "running" : "not running yet"} · ${escapeHtml(t.note)}</small></span></a>`).join("")
      : `<div class="empty">No tool portals configured. Start the portal with <code>amp orb services ensure</code>.</div>`;
  } catch {
    menu.innerHTML = `<div class="empty">Couldn't load tools.</div>`;
  }
}
$("#tools-btn").onclick = (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  if (!menu.hidden) refreshTools();
};
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target)) menu.hidden = true;
});
setInterval(() => !menu.hidden && refreshTools(), 10000);

// ------------------------------------------------------------------ boot
if (localStorage.getItem("kubelab.terminalWidth")) pane.style.width = localStorage.getItem("kubelab.terminalWidth");
if (localStorage.getItem("kubelab.terminal") === "1") setTerminal(true);
window.addEventListener("hashchange", route);
loadNav().then(route);
