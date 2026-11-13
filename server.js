const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const GROUP_PASSWORD = process.env.GROUP_PASSWORD;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const rootDirectory = __dirname;
const sessions = new Map();
const eventStreams = new Set();
const messages = [];
const activities = [];
const loginAttempts = new Map();
let groupName = "Our Group";

if (!GROUP_PASSWORD) {
  console.error("GROUP_PASSWORD is required. Set it in .env or the process environment.");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be a valid TCP port.");
  process.exit(1);
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        settled = true;
        reject(Object.assign(new Error("Request must contain valid JSON."), { status: 400 }));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function getSession(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.match(/(?:^|;\s*)group_session=([a-f0-9]+)/)?.[1];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireSession(request, response) {
  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Please sign in to continue." });
    return null;
  }
  return session;
}

function broadcast(event, data) {
  const encoded = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of eventStreams) {
    response.write(encoded);
  }
}

function trimHistory(list) {
  if (list.length > 100) list.splice(0, list.length - 100);
}

function limitLoginAttempts(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.blockedUntil > now) return record.blockedUntil;
  if (!record || record.windowStartedAt + 15 * 60 * 1000 <= now) {
    loginAttempts.set(ip, { count: 0, windowStartedAt: now, blockedUntil: 0 });
  }
  return 0;
}

function secureCookie(request) {
  return request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
}

function serveFile(response, fileName, contentType) {
  fs.readFile(path.join(rootDirectory, fileName), (error, content) => {
    if (error) {
      sendJson(response, 500, { error: "Unable to load the website." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/") {
    serveFile(response, "index.html", "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/styles.css") {
    serveFile(response, "styles.css", "text/css; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    serveFile(response, "app.js", "text/javascript; charset=utf-8");
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const ip = request.socket.remoteAddress || "unknown";
    const blockedUntil = limitLoginAttempts(ip);
    if (blockedUntil) {
      sendJson(response, 429, { error: "Too many attempts. Please try again later." }, {
        "Retry-After": String(Math.ceil((blockedUntil - Date.now()) / 1000)),
      });
      return;
    }

    try {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (name.length < 1 || name.length > 30 || /[\u0000-\u001f\u007f]/.test(name)) {
        sendJson(response, 400, { error: "Your name must be 1–30 characters." });
        return;
      }

      const passwordMatches = Buffer.byteLength(password) === Buffer.byteLength(GROUP_PASSWORD)
        && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(GROUP_PASSWORD));
      if (!passwordMatches) {
        const record = loginAttempts.get(ip);
        const nextRecord = record && record.windowStartedAt + 15 * 60 * 1000 > Date.now()
          ? record
          : { count: 0, windowStartedAt: Date.now(), blockedUntil: 0 };
        nextRecord.count += 1;
        if (nextRecord.count >= 5) nextRecord.blockedUntil = Date.now() + 15 * 60 * 1000;
        loginAttempts.set(ip, nextRecord);
        sendJson(response, 401, { error: "That password is not correct." });
        return;
      }

      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { name, expiresAt: Date.now() + SESSION_TTL_MS });
      sendJson(response, 200, { name }, {
        "Set-Cookie": `group_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie(request) ? "; Secure" : ""}`,
      });
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message || "Unable to sign in." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    const cookie = request.headers.cookie || "";
    const token = cookie.match(/(?:^|;\s*)group_session=([a-f0-9]+)/)?.[1];
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true }, {
      "Set-Cookie": "group_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const session = getSession(request);
    if (!session) {
      sendJson(response, 200, { authenticated: false });
      return;
    }
    sendJson(response, 200, { authenticated: true, name: session.name, groupName, messages, activities });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const session = requireSession(request, response);
    if (!session) return;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify({ groupName, messages, activities })}\n\n`);
    eventStreams.add(response);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 25000);
    response.on("close", () => {
      clearInterval(keepAlive);
      eventStreams.delete(response);
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    const session = requireSession(request, response);
    if (!session) return;
    try {
      const body = await readJson(request);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 500) {
        sendJson(response, 400, { error: "Messages must be 1–500 characters." });
        return;
      }
      const message = {
        id: crypto.randomUUID(),
        name: session.name,
        text,
        timestamp: new Date().toISOString(),
      };
      messages.push(message);
      trimHistory(messages);
      broadcast("message", message);
      sendJson(response, 201, { message });
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message || "Unable to send message." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/group-name") {
    const session = requireSession(request, response);
    if (!session) return;
    try {
      const body = await readJson(request);
      const nextName = typeof body.name === "string" ? body.name.trim() : "";
      if (!nextName || nextName.length > 40 || /[\u0000-\u001f\u007f]/.test(nextName)) {
        sendJson(response, 400, { error: "Group names must be 1–40 characters." });
        return;
      }
      if (nextName === groupName) {
        sendJson(response, 400, { error: "That is already the group name." });
        return;
      }

      groupName = nextName;
      const activity = {
        id: crypto.randomUUID(),
        name: session.name,
        text: `${session.name} changed the group name to ${groupName}`,
        timestamp: new Date().toISOString(),
      };
      activities.push(activity);
      trimHistory(activities);
      broadcast("group-name", { groupName, activity });
      sendJson(response, 200, { groupName, activity });
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message || "Unable to change the group name." });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`Group chat is running at http://localhost:${PORT}`);
});

server.on("error", (error) => {
  console.error("The web server could not start:", error.message);
  process.exitCode = 1;
});
