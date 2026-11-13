const loginView = document.querySelector("#login-view");
const chatView = document.querySelector("#chat-view");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const messageList = document.querySelector("#message-list");
const activityList = document.querySelector("#activity-list");
const eventSources = { current: null };
let toastTimer;
let seenMessages = new Set();
let seenActivities = new Set();

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function setConnectionStatus(connected) {
  const status = document.querySelector("#connection-status");
  status.classList.toggle("offline", !connected);
  status.lastChild.textContent = connected ? " Live" : " Reconnecting";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function makeMessage(message) {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.id = message.id;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = Array.from(message.name)[0] || "?";

  const content = document.createElement("div");
  content.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = message.name;
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.timestamp;
  time.textContent = formatTime(message.timestamp);
  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message.text;

  meta.append(author, time);
  content.append(meta, text);
  article.append(avatar, content);
  return article;
}

function makeActivity(activity) {
  const item = document.createElement("article");
  item.className = "activity-item";
  item.dataset.id = activity.id;
  const icon = document.createElement("span");
  icon.className = "activity-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "✎";
  const content = document.createElement("div");
  const text = document.createElement("p");
  text.className = "activity-text";
  const name = document.createElement("strong");
  name.textContent = activity.name;
  const suffix = document.createTextNode(activity.text.slice(activity.name.length));
  text.append(name, suffix);
  const time = document.createElement("time");
  time.className = "activity-time";
  time.dateTime = activity.timestamp;
  time.textContent = formatTime(activity.timestamp);
  content.append(text, time);
  item.append(icon, content);
  return item;
}

function showMessage(message) {
  if (seenMessages.has(message.id)) return;
  seenMessages.add(message.id);
  document.querySelector("#empty-chat")?.remove();
  messageList.append(makeMessage(message));
  messageList.scrollTop = messageList.scrollHeight;
}

function showActivity(activity) {
  if (seenActivities.has(activity.id)) return;
  seenActivities.add(activity.id);
  document.querySelector("#empty-activity")?.remove();
  activityList.prepend(makeActivity(activity));
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function setGroupName(name) {
  document.querySelector("#group-title").textContent = name;
  document.title = `${name} · Gather`;
}

function showChat(state) {
  loginView.hidden = true;
  chatView.hidden = false;
  document.querySelector("#current-user").textContent = state.name;
  setGroupName(state.groupName);
  for (const message of state.messages) showMessage(message);
  for (const activity of state.activities) showActivity(activity);
  if (!eventSources.current) connectEvents();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  eventSources.current = source;
  source.addEventListener("open", () => setConnectionStatus(true));
  source.addEventListener("error", () => setConnectionStatus(false));
  source.addEventListener("snapshot", (event) => {
    const state = JSON.parse(event.data);
    setGroupName(state.groupName);
    for (const message of state.messages) showMessage(message);
    for (const activity of state.activities) showActivity(activity);
  });
  source.addEventListener("message", (event) => showMessage(JSON.parse(event.data)));
  source.addEventListener("group-name", (event) => {
    const change = JSON.parse(event.data);
    setGroupName(change.groupName);
    showActivity(change.activity);
  });
}

async function restoreSession() {
  try {
    const state = await requestJson("/api/state");
    if (state.authenticated) showChat(state);
    else loginView.hidden = false;
  } catch {
    loginView.hidden = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  const formData = new FormData(loginForm);
  loginError.textContent = "";
  button.disabled = true;
  try {
    const state = await requestJson("/api/login", {
      method: "POST",
      body: JSON.stringify({ name: formData.get("name"), password: formData.get("password") }),
    });
    loginForm.reset();
    showChat({ ...state, groupName: "Our Group", messages: [], activities: [] });
    restoreSession();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#message-input");
  const errorLabel = document.querySelector("#message-error");
  errorLabel.textContent = "";
  try {
    await requestJson("/api/messages", { method: "POST", body: JSON.stringify({ text: input.value }) });
    input.value = "";
    input.focus();
  } catch (error) {
    errorLabel.textContent = error.message;
  }
});

const renamePanel = document.querySelector("#rename-panel");
document.querySelector("#rename-button").addEventListener("click", () => {
  renamePanel.hidden = !renamePanel.hidden;
  if (!renamePanel.hidden) {
    const input = document.querySelector("#group-name-input");
    input.value = document.querySelector("#group-title").textContent;
    input.focus();
  }
});

document.querySelector("#cancel-rename").addEventListener("click", () => {
  renamePanel.hidden = true;
  document.querySelector("#rename-error").textContent = "";
});

document.querySelector("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#group-name-input");
  const errorLabel = document.querySelector("#rename-error");
  errorLabel.textContent = "";
  try {
    const change = await requestJson("/api/group-name", {
      method: "POST",
      body: JSON.stringify({ name: input.value }),
    });
    setGroupName(change.groupName);
    showActivity(change.activity);
    renamePanel.hidden = true;
    showToast("Group name updated for everyone.");
  } catch (error) {
    errorLabel.textContent = error.message;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  eventSources.current?.close();
  eventSources.current = null;
  try {
    await requestJson("/api/logout", { method: "POST", body: "{}" });
  } catch (error) {
    showToast(error.message);
  }
  chatView.hidden = true;
  loginView.hidden = false;
  seenMessages = new Set();
  seenActivities = new Set();
  messageList.replaceChildren();
  activityList.replaceChildren();
  loginForm.reset();
});

restoreSession();
