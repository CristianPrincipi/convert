const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopUpdater", {
  getState: () => ipcRenderer.invoke("updater:get-state"),
  check: () => ipcRenderer.invoke("updater:check"),
  setAutoUpdate: (enabled) => ipcRenderer.invoke("updater:set-auto-update", enabled === true),
  install: () => ipcRenderer.invoke("updater:install"),
  openRelease: () => ipcRenderer.invoke("updater:open-release"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("updater:state", listener);
    return () => ipcRenderer.removeListener("updater:state", listener);
  },
});

// linux-local: each window of the desktop app has a role, passed by src/electron-linux.cjs
const role =
  process.argv.find((arg) => arg.startsWith("--convert-role="))?.slice("--convert-role=".length) ??
  "app";

if (role === "app") {
  // Files the app was launched with, see src/ui/DesktopLaunch.ts
  contextBridge.exposeInMainWorld("desktopLaunch", {
    takeFiles: () => ipcRenderer.invoke("launch:take"),
    onFiles: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("launch:files", listener);
      return () => ipcRenderer.removeListener("launch:files", listener);
    },
  });
} else if (role === "engine") {
  // Hidden window that converts for the wheel, see src/ui/DesktopEngine.ts
  contextBridge.exposeInMainWorld("desktopEngine", {
    ready: () => ipcRenderer.send("engine:ready"),
    onRequest: (callback) => {
      ipcRenderer.on("engine:request", (_event, request) => callback(request));
    },
    respond: (id, result, error) => ipcRenderer.send("engine:response", { id, result, error }),
  });
} else if (role === "wheel") {
  // The right-click wheel, see public/wheel/
  contextBridge.exposeInMainWorld("desktopWheel", {
    onShow: (callback) => ipcRenderer.on("wheel:show", (_event, data) => callback(data)),
    onPlace: (callback) => ipcRenderer.on("wheel:place", (_event, place) => callback(place)),
    choose: (target) => ipcRenderer.send("wheel:choose", String(target)),
    cancel: () => ipcRenderer.send("wheel:cancel"),
    openApp: () => ipcRenderer.send("wheel:open-app"),
  });
}
