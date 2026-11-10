# Change Log

All notable changes to the **Device Screenshot (Android & iOS)** extension will be documented in this file.

---

## [1.0.2] - 2026-11-10

### Added
- **Compact Run & Debug Card (Independent Target Spinner + Flavor Spinner)**:
  - Positioned at the top of the sidebar above `Connected Devices`, separating **Run & Debug target selection** from **Screenshot device selection**.
  - **Offline Emulator & Simulator Auto-Boot**: Lists connected physical devices first (`Available Devices`) followed by offline Android AVDs (normal & cold boot) and `Start iOS Simulator` (`Offline Emulators`), automatically booting selected offline emulators when launching.
  - **Flavor Spinner & Live Session Controls**: Reads `.vscode/launch.json` configurations/flavors and launches with `suppressDebugView: true` (keeping focus in your current sidebar instead of jumping to the Run and Debug tab), with live **Hot Reload (`⚡`)**, **Hot Restart (`↻`)**, and **Stop (`■`)** buttons + Dart Tooling Daemon (`Editor.selectDevice`) synchronization.
- **Space-Efficient & Occlusion-Free Sidebar UI**:
  - Moved the single-row action bar (**Recapture `R`**, **Copy `Cmd+C`**, **Save `Cmd+S`**, **Save As**, **Send to Prompt**) **directly above the screenshot viewport** so buttons remain 100% visible even on short windows or when bottom IDE notification toasts appear.
  - Consolidated transform, resolution scale, and zoom controls into a **translucent bottom-right in-screen floating HUD** so the underlying screenshot remains visible behind the toolbar.
  - Applied high-visibility emerald green accent styling to `[↻ Refresh]` and `[↻ Recapture]` buttons, with `[↻ Recapture]` enabled immediately upon device selection.

### Fixed
- **Smart Active AI Prompt Routing (`Send to Prompt`)**:
  - Detects which AI chat panel is currently expanded/active (**GitHub Copilot Chat** vs **Antigravity**) and attaches screenshots directly to the active prompt (`workbench.action.chat.open` `attachFiles` for Copilot Chat) without unfolding collapsed Antigravity panels.
- **iOS Physical Device Detection**:
  - Fixed iPhone/iPad physical devices not appearing when Xcode `xcrun devicectl` reports `available (paired)` (idle on-demand CoreDevice tunnel with `state: "disconnected"` and `transportType: "wired"` / `"localNetwork"`), and added `ioreg` hardware USB serial cross-checking.

---

## [1.0.1] - 2026-11-04

### Added
- **Hotplug Real-time Device Auto-Detection**:
  - Automatically updates the connected device list within 1~2 seconds when USB devices are plugged in or disconnected, without requiring a manual click on the [Refresh] button.
  - Light-weight background watcher (1.5s interval) active only when the sidebar view or screenshot panel is open.
  - Auto-cancels watching on panel close to eliminate CPU and battery consumption.
  - Integrated in-memory Android model caching to reduce background check time to under 20ms.
- **Visual USB vs Wi-Fi Connection Indicators**:
  - Real-time badges for connection medium:
    - 🟢 **`[USB]`** for wired cable connections.
    - 🔵 **`[Wi-Fi]`** for wireless network debugging (`localNetwork` on iOS / IP-based on Android).
    - ⚪ **`[Simulator]`** / **`[Emulator]`** for virtual devices.
  - Detailed sub-info text reflecting connection type: `iOS · Wi-Fi · <UDID>` / `Android · USB · <Serial>`.
  - Reflects connection type in Large Editor Tab device dropdown and Command Palette QuickPick (`[iPhone Wi-Fi]`, `[Android USB]`).
- **One-Click Local Deployment Script**:
  - Added `npm run deploy:local` to automatically build, package VSIX, and deploy directly into both Visual Studio Code and Antigravity IDE.

### Fixed
- Fixed an issue where iOS devices paired with Xcode "Connect via network" remained in the device list after USB disconnection without clear connection status.
- Fixed device state fingerprint comparison bug that prevented hotplug event emission.

---

## [1.0.0] - 2026-11-03

### Initial Release
- **Physical Device First**: Automatic detection and top sorting of physical Android (`adb`) and iOS devices (`xcrun devicectl`, `idevicescreenshot`, `xcrun simctl`).
- **Clean Standby State**: Prevents accidental screen captures on open; captures only upon device selection.
- **macOS-Style Annotation & Markup**:
  - Freehand Pen, Semi-transparent Highlighter.
  - Non-destructive Eraser ring preserving underlying screenshot image.
  - Shapes (Rectangle, Circle, Arrow) and Text.
  - Area Crop with live selection bounds.
  - Undo (up to 30 steps) and 1-Click Reset to Original.
- **Color Customization**:
  - 5 Preset color swatches + 3 interactive custom color slots with HEX input.
  - Visual circle stroke thickness selector (Thin, Medium, Thick).
- **Fast Action Workflow**:
  - 1-Click Recapture (`R`), Copy to Clipboard (`Cmd+C`), Save Image (`Cmd+S`), Save As.
  - **Send to AI Prompt** for seamless pair programming workflows.
  - 90° Left/Right Rotation, display corner rounding, pixel grid toggle.
- **Multilingual Support (12 Languages)**:
  - English, 한국어, 日本語, 中文, हिन्दी, Português, Français, Español, Bahasa Melayu, Tiếng Việt, ไทย, Deutsch.
