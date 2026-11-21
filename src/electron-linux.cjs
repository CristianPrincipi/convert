// linux-local: file manager integration for the desktop app.
//
//   convert-to-it [files]          open the app (with the files already loaded)
//   convert-to-it --wheel files    show the conversion wheel at the cursor, save beside the source
//   convert-to-it --daemon         stay in the background so the wheel opens instantly
//
// Later launches hand their arguments to the running instance through Electron's single-instance
// lock. The wheel asks a hidden "engine" window (src/ui/DesktopEngine.ts) which formats the file
// can reach and lets it run the conversion; the wheel itself is public/wheel/.
const { app, BrowserWindow, ipcMain, Notification, shell } = require("electron");
const { execFile } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const path = require("path");
const fs = require("fs");

const APP_URL = "app://-/index.html";
const WHEEL_URL = "app://-/wheel/index.html";
/** Hyprland window rules match the wheel by this title */
const WHEEL_TITLE = "convert-wheel";
const ENGINE_START_TIMEOUT = 60_000;
const SLOW_CONVERSION_NOTICE = 1500;

let createAppWindow = null;
let appWindow = null;
let pendingLaunchFiles = [];
let resident = false;

function parseArgs(argv, cwd) {
  const args = argv.slice(1);
  const files = args
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => path.resolve(cwd, arg.startsWith("file://") ? fileURLToPath(arg) : arg))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  return { daemon: args.includes("--daemon"), wheel: args.includes("--wheel"), files };
}

const preloadPath = () => path.join(app.getAppPath(), "src", "electron-preload.cjs");

const webPreferences = (role) => ({
  nodeIntegration: false,
  contextIsolation: true,
  webSecurity: true,
  backgroundThrottling: false,
  preload: preloadPath(),
  additionalArguments: [`--convert-role=${role}`],
});

const isFrom = (event, window) =>
  !!window && !window.isDestroyed() && event.sender === window.webContents;

/* ---------- the normal app window ---------- */

function openApp(files) {
  if (files.length) pendingLaunchFiles = files;
  if (!appWindow || appWindow.isDestroyed()) {
    appWindow = createAppWindow();
    appWindow.on("closed", () => (appWindow = null));
    return;
  }
  if (files.length) appWindow.webContents.send("launch:files");
  if (appWindow.isMinimized()) appWindow.restore();
  appWindow.show();
  appWindow.focus();
}

async function readLaunchFile(file) {
  const [bytes, stat] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
  return { name: path.basename(file), bytes, lastModified: stat.mtimeMs };
}

/* ---------- the hidden conversion engine ---------- */

let engineWindow = null;
let engineReady = false;
let engineStartTimer = null;
let nextRequestId = 1;
const engineRequests = new Map();
const engineWaiting = [];

function failEngineRequests(message) {
  for (const { reject } of engineRequests.values()) reject(new Error(message));
  engineRequests.clear();
  engineWaiting.length = 0;
}

function ensureEngine() {
  if (engineWindow && !engineWindow.isDestroyed()) return;
  engineReady = false;
  engineWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: webPreferences("engine"),
  });
  void engineWindow.loadURL(APP_URL);
  engineStartTimer = setTimeout(() => {
    if (engineReady) return;
    failEngineRequests("Convert non è riuscito a caricare i formati.");
    engineWindow?.destroy();
  }, ENGINE_START_TIMEOUT);
  engineWindow.webContents.on("render-process-gone", () => engineWindow?.destroy());
  engineWindow.on("closed", () => {
    clearTimeout(engineStartTimer);
    engineWindow = null;
    engineReady = false;
    failEngineRequests("Il motore di conversione si è chiuso.");
  });
}

function callEngine(op, payload) {
  ensureEngine();
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    engineRequests.set(id, { resolve, reject });
    const send = () => engineWindow?.webContents.send("engine:request", { id, op, ...payload });
    if (engineReady) send();
    else engineWaiting.push(send);
  });
}

ipcMain.on("engine:ready", (event) => {
  if (!isFrom(event, engineWindow)) return;
  clearTimeout(engineStartTimer);
  engineReady = true;
  for (const send of engineWaiting.splice(0)) send();
});

ipcMain.on("engine:response", (event, response) => {
  if (!isFrom(event, engineWindow)) return;
  const request = engineRequests.get(response?.id);
  if (!request) return;
  engineRequests.delete(response.id);
  if (response.error) request.reject(new Error(response.error));
  else request.resolve(response.result);
});

/* ---------- Hyprland ---------- */

function hyprctl(...args) {
  return new Promise((resolve) => {
    execFile("hyprctl", ["-j", ...args], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** The monitor under the cursor, in logical (CSS) pixels */
async function cursorMonitor() {
  const [cursor, monitors] = await Promise.all([hyprctl("cursorpos"), hyprctl("monitors")]);
  if (!cursor || !Array.isArray(monitors) || !monitors.length) return null;
  const sized = monitors.map((m) => {
    const rotated = m.transform % 2 === 1;
    const width = (rotated ? m.height : m.width) / m.scale;
    const height = (rotated ? m.width : m.height) / m.scale;
    return { ...m, lw: Math.round(width), lh: Math.round(height) };
  });
  const monitor =
    sized.find(
      (m) => cursor.x >= m.x && cursor.x < m.x + m.lw && cursor.y >= m.y && cursor.y < m.y + m.lh,
    ) ??
    sized.find((m) => m.focused) ??
    sized[0];
  const [left = 0, top = 0, right = 0, bottom = 0] = Array.isArray(monitor.reserved)
    ? monitor.reserved
    : [];
  return { cursor, monitor, insets: { left, top, right, bottom } };
}

/** Where Hyprland actually put the wheel window, once it is mapped */
async function wheelWindowOrigin() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const clients = await hyprctl("clients");
    const client = Array.isArray(clients)
      ? clients.find(
          (c) => c.pid === process.pid && c.title === WHEEL_TITLE && c.mapped && !c.hidden,
        )
      : null;
    if (client) return { x: client.at[0], y: client.at[1] };
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return null;
}

/* ---------- the wheel ---------- */

let wheelWindow = null;
let wheelLoaded = null;
let wheelFiles = [];
let wheelShowing = 0;

function ensureWheel() {
  if (wheelWindow && !wheelWindow.isDestroyed()) return wheelWindow;
  wheelWindow = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: WHEEL_TITLE,
    width: 800,
    height: 600,
    webPreferences: webPreferences("wheel"),
  });
  wheelWindow.on("page-title-updated", (event) => event.preventDefault());
  wheelWindow.on("blur", () => hideWheel());
  wheelWindow.on("closed", () => {
    wheelWindow = null;
    wheelLoaded = null;
  });
  wheelLoaded = wheelWindow.loadURL(WHEEL_URL);
  return wheelWindow;
}

function hideWheel() {
  wheelShowing++;
  if (wheelWindow && !wheelWindow.isDestroyed() && wheelWindow.isVisible()) wheelWindow.hide();
}

async function showWheel(files) {
  if (!files.length) return;
  const showing = ++wheelShowing;
  let targets;
  try {
    targets = await callEngine("targets", { name: path.basename(files[0]) });
  } catch (error) {
    notify("Conversione non disponibile", String(error.message ?? error));
    return;
  }
  if (!targets.categories.some((category) => category.items.length)) {
    notify(
      "Nessuna conversione",
      `Convert non sa convertire ${path.basename(files[0])} nei formati della ruota.`,
    );
    return;
  }

  const window = ensureWheel();
  await wheelLoaded;
  const screen = await cursorMonitor();
  if (showing !== wheelShowing) return;

  wheelFiles = files;
  if (screen) window.setSize(screen.monitor.lw, screen.monitor.lh);
  window.webContents.send("wheel:show", {
    files: files.map((file) => path.basename(file)),
    source: targets.source,
    categories: targets.categories,
    insets: screen?.insets ?? null,
  });
  window.show();
  window.focus();

  // Hyprland places the window (see linux/hypr/convert.lua); the wheel goes where the cursor is
  const origin = screen ? await wheelWindowOrigin() : null;
  if (showing !== wheelShowing) return;
  const place = origin
    ? {
        x: screen.cursor.x - origin.x,
        y: screen.cursor.y - origin.y,
        insets: {
          top: Math.max(0, screen.monitor.y + screen.insets.top - origin.y),
          left: Math.max(0, screen.monitor.x + screen.insets.left - origin.x),
          right: screen.insets.right,
          bottom: screen.insets.bottom,
        },
      }
    : null;
  window.webContents.send("wheel:place", place);
}

ipcMain.on("wheel:choose", (event, target) => {
  if (!isFrom(event, wheelWindow)) return;
  const files = wheelFiles;
  hideWheel();
  void convertBesideSource(files, target);
});

ipcMain.on("wheel:cancel", (event) => {
  if (isFrom(event, wheelWindow)) hideWheel();
});

ipcMain.on("wheel:open-app", (event) => {
  if (!isFrom(event, wheelWindow)) return;
  const files = wheelFiles;
  hideWheel();
  openApp(files);
});

/* ---------- converting and saving ---------- */

/** "name.ext", or "name (1).ext", "name (2).ext"… if it is taken; written without overwriting */
async function writeBeside(dir, name, bytes) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(dir, n ? `${base} (${n})${ext}` : name);
    try {
      await fs.promises.writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Troppi file chiamati ${name}`);
}

async function convertBesideSource(files, target) {
  const label = files.length > 1 ? `${files.length} file` : path.basename(files[0]);
  const slow = setTimeout(
    () => notify("Conversione in corso", `${label} → ${target.toUpperCase()}`),
    SLOW_CONVERSION_NOTICE,
  );
  try {
    const inputs = await Promise.all(
      files.map(async (file) => ({
        name: path.basename(file),
        bytes: await fs.promises.readFile(file),
      })),
    );
    const { outputs, failed } = await callEngine("convert", { files: inputs, target });
    const dir = path.dirname(files[0]);
    const saved = [];
    for (const output of outputs)
      saved.push(await writeBeside(dir, path.basename(output.name), output.bytes));

    if (!saved.length) {
      notify(
        "Conversione non riuscita",
        `Nessun percorso trovato per ${label} → ${target.toUpperCase()}.`,
      );
      return;
    }
    const names = saved.map((file) => path.basename(file));
    const body =
      names.length > 3
        ? `${names.length} file salvati in ${dir}`
        : `Salvat${names.length > 1 ? "i" : "o"} accanto all'originale: ${names.join(", ")}`;
    const failure = failed.length ? `\nNon convertiti: ${failed.join(", ")}` : "";
    notify(failed.length ? "Conversione in parte riuscita" : "Fatto", body + failure, saved[0]);
  } catch (error) {
    notify("Conversione non riuscita", `${label}: ${error.message ?? error}`);
  } finally {
    clearTimeout(slow);
  }
}

const shownNotifications = new Set();

function notify(title, body, revealFile) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  if (revealFile) notification.on("click", () => shell.showItemInFolder(revealFile));
  shownNotifications.add(notification);
  notification.on("close", () => shownNotifications.delete(notification));
  notification.show();
}

/* ---------- launching ---------- */

function handleArgs({ daemon, wheel, files }) {
  if (daemon || wheel) {
    resident = true;
    ensureEngine();
    ensureWheel();
  }
  if (wheel) void showWheel(files);
  else if (!daemon) openApp(files);
}

/**
 * Call before the app is ready. Returns false when another instance is already running
 * (the arguments were handed to it and this process should quit).
 */
function init() {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", (_event, argv, workingDirectory) => {
    if (app.isReady()) handleArgs(parseArgs(argv, workingDirectory));
  });

  ipcMain.handle("launch:take", async (event) => {
    if (!isFrom(event, appWindow)) return [];
    const paths = pendingLaunchFiles;
    pendingLaunchFiles = [];
    const files = [];
    for (const file of paths) {
      try {
        files.push(await readLaunchFile(file));
      } catch (error) {
        console.error(`Could not read ${file}:`, error);
      }
    }
    return files;
  });
  return true;
}

/** Call once the app is ready, with the function that creates the app's main window. */
function start(createWindow) {
  createAppWindow = createWindow;
  handleArgs(parseArgs(process.argv, process.cwd()));
}

/** Whether the app keeps running in the background with no visible window */
const isResident = () => resident;

module.exports = { init, start, isResident };
