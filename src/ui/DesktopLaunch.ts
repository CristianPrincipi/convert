// linux-local: open the files the desktop app was launched with (e.g. from a file manager's
// right-click action). Exposed by src/electron-preload.cjs; absent in the web build.
import { effect } from "@preact/signals";
import mime from "mime";

import { ConversionInProgress, CurrentPage, LoadingToolsText, Pages, PopupData } from "./AppState";
import { openPopup } from "./PopupStore";
import { SelectedFiles } from "src/main";

interface LaunchFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  lastModified: number;
}

export interface DesktopLaunch {
  takeFiles: () => Promise<LaunchFile[]>;
  onFiles: (callback: () => void) => () => void;
}

const launch = window.desktopLaunch;

const canAccept = () => LoadingToolsText.value === undefined && !ConversionInProgress.value;

if (launch) {
  // Files may arrive before the formats have loaded; take them once the app can use them
  let pending = true;

  const take = async () => {
    if (!canAccept()) {
      pending = true;
      return;
    }
    pending = false;
    const launched = await launch.takeFiles();
    if (!launched.length) return;

    const files = launched.map(
      (file) =>
        new File([file.bytes], file.name, {
          type: mime.getType(file.name) ?? "",
          lastModified: file.lastModified,
        }),
    );

    if (!files.every((file) => file.type === files[0].type)) {
      PopupData.value = {
        title: "Invalid selection",
        text: "All input files must be of the same type.",
        dismissible: true,
        buttonText: "OK",
      };
      openPopup();
      return;
    }

    SelectedFiles.value = Object.fromEntries(
      files.map((file) => [`${file.name}-${file.lastModified}`, file]),
    );
    CurrentPage.value = Pages.Conversion;
  };

  launch.onFiles(() => void take());
  effect(() => {
    if (canAccept() && pending) void take();
  });
}
