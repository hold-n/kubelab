#!/usr/bin/env node
// kubelab portal server (Node.js, no dependencies). Two modes:
//
//   node portal/server.mjs docs
//     Serves the course as a web app: rendered lessons, a file viewer, and a browser
//     terminal (ttyd, proxied from TERMINAL_PORT under /terminal/).
//
//   node portal/server.mjs forward --name Consul --namespace toolbox --target pod/consul \
//        --remote-port 8500 [--selector key=value] [--hint "..."] [--path /ui/]
//     A reverse proxy in front of a `kubectl port-forward` that it keeps alive, so a tool's
//     web UI inside the cluster gets a stable portal URL. It shows a friendly "not running
//     yet" page while the target doesn't exist.
//
// Both modes listen on $PORT (supplied by `amp orb services ensure`, see .amp/services.yaml).

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8000);
const mode = process.argv[2];

// ---------------------------------------------------------------- proxy helpers

function proxyHttp(req, res, port, onDown) {
  const upstream = http.request(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => (res.headersSent ? res.destroy() : onDown(req, res)));
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, port) {
  const up = net.connect(port, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

// Portal requests carry X-Amp-Authenticated. Only the thread's collaborators may use the
// terminal. Requests from inside the orb (no header) are allowed.
function isCollaborator(req) {
  const h = req.headers["x-amp-authenticated"];
  return h === undefined || String(h).includes("collaborator=yes");
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// ---------------------------------------------------------------- docs mode

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};

function lessonNav() {
  const dir = path.join(REPO, "lessons");
  const lessons = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "README.md"))).sort();
  const title = (file) => {
    const m = fs.readFileSync(file, "utf8").match(/^#\s+(.+)$/m);
    return m ? m[1].replace(/^\d+\s+[—-]\s+/, "") : path.basename(path.dirname(file));
  };
  return [
    { path: "README.md", num: "", title: "Start here" },
    ...lessons.map((d) => ({ path: `lessons/${d}/README.md`, num: d.slice(0, 2), title: title(path.join(dir, d, "README.md")) })),
  ];
}

// Public portal URLs of the tool UIs, injected by .amp/services.yaml as env vars.
function toolLinks() {
  const tools = [
    ["Prometheus", "PROMETHEUS_URL", "Metrics & PromQL (lesson 16)"],
    ["Consul", "CONSUL_URL", "Service catalog & KV (lesson 16)"],
    ["Vault", "VAULT_URL", "Secrets UI, token: root (lesson 16)"],
    ["Gateway", "GATEWAY_URL", "The lesson 09 Gateway"],
  ];
  return tools.filter(([, env]) => process.env[env]).map(([name, env, note]) => ({ name, url: process.env[env], note }));
}

async function toolStatus() {
  return Promise.all(
    toolLinks().map(async (t) => {
      try {
        const r = await fetch(new URL("/__kubelab/status", t.url), { signal: AbortSignal.timeout(2000) });
        return { ...t, up: (await r.json()).up };
      } catch {
        return { ...t, up: false };
      }
    }),
  );
}

function pasteToTerminal(text, res) {
  // Paste (not type) into the tmux session behind the web terminal. Bracketed paste (-p)
  // means bash inserts multi-line text without running it until you press Enter.
  const load = spawn("tmux", ["load-buffer", "-b", "kubelab", "-"]);
  load.stdin.end(text);
  load.on("close", (code) => {
    if (code !== 0) return send(res, 409, "Terminal isn't running yet - open it first.");
    execFile("tmux", ["paste-buffer", "-p", "-d", "-b", "kubelab", "-t", "kubelab"], (err) =>
      err ? send(res, 409, "Terminal isn't running yet - open it first.") : send(res, 204, ""),
    );
  });
}

function serveRepoFile(rel, res) {
  const abs = path.resolve(REPO, rel);
  if (!abs.startsWith(REPO + path.sep) || rel.split("/").some((p) => p.startsWith("."))) return send(res, 403, "forbidden");
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    fs.createReadStream(abs).pipe(res);
  });
}

function docs() {
  const terminalPort = Number(process.env.TERMINAL_PORT || 7681);
  const terminalDown = (req, res) =>
    send(res, 503, `<body style="font:14px system-ui;padding:2em;color:#ccc;background:#1e1e1e">
      Terminal service isn't running. In the orb, run <code>amp orb services ensure</code>.</body>`, "text/html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);

    if (p === "/healthz") return send(res, 200, "ok");
    if (p.startsWith("/terminal")) {
      if (!isCollaborator(req)) return send(res, 403, "The terminal is only available to this thread's collaborators.");
      return proxyHttp(req, res, terminalPort, terminalDown);
    }
    if (p === "/api/nav") return send(res, 200, JSON.stringify(lessonNav()), "application/json");
    if (p === "/api/tools") return send(res, 200, JSON.stringify(await toolStatus()), "application/json");
    if (p === "/api/paste" && req.method === "POST") {
      if (!isCollaborator(req)) return send(res, 403, "forbidden");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => pasteToTerminal(body, res));
      return;
    }
    if (p.startsWith("/repo/")) return serveRepoFile(p.slice("/repo/".length), res);
    if (p === "/api/ls") {
      const rel = url.searchParams.get("path") || "";
      const abs = path.resolve(REPO, rel);
      if (!(abs + path.sep).startsWith(REPO + path.sep) || rel.split("/").some((s) => s.startsWith("."))) return send(res, 403, "forbidden");
      fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
        if (err) return send(res, 404, "not found");
        const list = entries.filter((e) => !e.name.startsWith(".")).map((e) => e.name + (e.isDirectory() ? "/" : ""))
          .sort((a, b) => (b.endsWith("/") - a.endsWith("/")) || a.localeCompare(b));
        send(res, 200, JSON.stringify(list), "application/json");
      });
      return;
    }

    // Static web app
    const file = path.join(REPO, "portal", "web", p === "/" ? "index.html" : p);
    if (!file.startsWith(path.join(REPO, "portal", "web"))) return send(res, 403, "forbidden");
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "not found");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith("/terminal") && isCollaborator(req)) return proxyUpgrade(req, socket, head, terminalPort);
    socket.destroy();
  });
  server.listen(PORT, () => console.log(`kubelab docs on :${PORT} (terminal -> :${terminalPort})`));
}

// ---------------------------------------------------------------- forward mode

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function kubectl(args) {
  return new Promise((resolve) => execFile("kubectl", args, (err, stdout) => resolve(err ? null : stdout.trim())));
}

async function forward() {
  const name = arg("name", "Service");
  const ns = arg("namespace", "default");
  const remotePort = arg("remote-port");
  const hint = arg("hint", "");
  const landing = arg("path", "/");
  let localPort = await freePort();
  let up = false;

  // Keep a `kubectl port-forward` running, re-resolving the target every time it exits
  // (pods get recreated, releases get reinstalled...).
  const loop = async () => {
    const selector = arg("selector");
    const target = selector
      ? await kubectl(["get", "svc", "-n", ns, "-l", selector, "-o", "name"]).then((o) => o?.split("\n")[0] || null)
      : (await kubectl(["get", "-n", ns, arg("target"), "-o", "name"])) && arg("target");
    if (!target) return setTimeout(loop, 5000);
    const pf = spawn("kubectl", ["port-forward", "-n", ns, target, `${localPort}:${remotePort}`, "--address", "127.0.0.1"]);
    pf.stdout.on("data", (d) => {
      if (String(d).includes("Forwarding from")) up = true;
    });
    pf.stderr.on("data", (d) => process.stderr.write(d));
    pf.on("exit", async () => {
      up = false;
      localPort = await freePort();
      setTimeout(loop, 2000);
    });
  };
  loop();

  const notRunning = (req, res) =>
    send(res, 503, `<!doctype html><meta http-equiv="refresh" content="5">
      <body style="font:16px system-ui;max-width:40em;margin:4em auto;color:#333">
      <h2>${name} isn't running in the cluster yet</h2>
      <p>${hint}</p><p style="color:#888">This page retries every 5 seconds.</p></body>`, "text/html; charset=utf-8");

  const server = http.createServer((req, res) => {
    if (req.url === "/__kubelab/status") return send(res, 200, JSON.stringify({ up }), "application/json");
    if (req.url === "/" && landing !== "/") {
      res.writeHead(302, { Location: landing });
      return res.end();
    }
    if (!up) return notRunning(req, res);
    proxyHttp(req, res, localPort, notRunning);
  });
  server.on("upgrade", (req, socket, head) => (up ? proxyUpgrade(req, socket, head, localPort) : socket.destroy()));
  server.listen(PORT, () => console.log(`${name} proxy on :${PORT} -> ${ns}/${arg("target") || arg("selector")}:${remotePort}`));
}

if (mode === "docs") docs();
else if (mode === "forward") forward();
else {
  console.error("usage: server.mjs docs | forward --name N --namespace NS (--target T | --selector S) --remote-port P");
  process.exit(1);
}
