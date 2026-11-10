import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DeviceManager, MobileDevice, OfflineEmulator } from './deviceManager';
import { LANGUAGE_OPTIONS, normalizeLanguage, SupportedLanguage, TRANSLATIONS } from './i18n';
import { LaunchManager } from './launchManager';
import { sendImageFileToActivePrompt } from './promptRouter';
import { ScreenshotPanel } from './screenshotPanel';

const RUN_DEVICE_STATE_KEY = 'deviceScreenshot.selectedRunDeviceId';

export class ScreenshotSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deviceScreenshot.sidebarView';

  private _view?: vscode.WebviewView;
  private _devices: MobileDevice[] = [];
  private _offlineEmulators: OfflineEmulator[] = [];
  private _selectedDevice?: MobileDevice;
  private _runDeviceId?: string;
  private _extraRunTarget?: { id: string; label: string };

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _deviceManager: DeviceManager,
    private readonly _launchManager: LaunchManager
  ) {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deviceScreenshot')) {
        this.sendSettingsToWebview();
      }
    });
  }

  private getLanguage(): SupportedLanguage {
    const lang = vscode.workspace.getConfiguration('deviceScreenshot').get<string>('language', 'en');
    return normalizeLanguage(lang);
  }

  private t(key: string): string {
    const lang = this.getLanguage();
    return TRANSLATIONS[lang][key] || TRANSLATIONS.en[key] || key;
  }

  private async resolveRunDeviceSelection(): Promise<void> {
    this._offlineEmulators = await this._deviceManager.listOfflineEmulators(this._devices);

    if (this._runDeviceId) {
      // If an offline emulator that was selected just booted, automatically switch to the live booted device!
      if (this._runDeviceId.startsWith('offline:ios:')) {
        const bootedSim = this._devices.find((d) => d.platform === 'ios' && d.reality === 'simulator');
        if (bootedSim) {
          this._runDeviceId = bootedSim.id;
          await this._context.workspaceState.update(RUN_DEVICE_STATE_KEY, this._runDeviceId);
          void this._launchManager.syncIdeSelectedDeviceById(this._runDeviceId);
          return;
        }
      } else if (this._runDeviceId.startsWith('offline:android')) {
        const targetAvd = this._runDeviceId.split(':').slice(2).join(':');
        const bootedEmu = this._devices.find((d) => d.avdId === targetAvd);
        if (bootedEmu) {
          this._runDeviceId = bootedEmu.id;
          await this._context.workspaceState.update(RUN_DEVICE_STATE_KEY, this._runDeviceId);
          void this._launchManager.syncIdeSelectedDeviceById(this._runDeviceId);
          return;
        }
      }

      const stillConnected = this._devices.find((d) => d.id === this._runDeviceId);
      const stillOffline = this._offlineEmulators.find((o) => o.id === this._runDeviceId);
      if (stillConnected || stillOffline || this._extraRunTarget?.id === this._runDeviceId) {
        return;
      }
    }

    // Priority 1: Connected devices (Physical devices first, then booted simulators)
    const savedId = this._context.workspaceState.get<string>(RUN_DEVICE_STATE_KEY);
    if (savedId) {
      const savedConnected = this._devices.find((d) => d.id === savedId);
      if (savedConnected) {
        this._runDeviceId = savedConnected.id;
        void this._launchManager.syncIdeSelectedDeviceById(this._runDeviceId);
        return;
      }
    }

    const ideDevId = await this._launchManager.getIdeSelectedDeviceId();
    if (ideDevId) {
      const ideFound = this._devices.find((d) => d.id.toLowerCase() === ideDevId.toLowerCase());
      if (ideFound) {
        this._runDeviceId = ideFound.id;
        return;
      }
    }

    if (this._devices.length > 0) {
      this._runDeviceId = this._devices[0].id;
      void this._launchManager.syncIdeSelectedDeviceById(this._runDeviceId);
      return;
    }

    // Priority 2: When no devices are currently connected, select saved or first offline emulator
    if (savedId) {
      const savedOffline = this._offlineEmulators.find((o) => o.id === savedId);
      if (savedOffline) {
        this._runDeviceId = savedOffline.id;
        return;
      }
    }

    this._runDeviceId = this._offlineEmulators[0]?.id;
  }

  public sendSettingsToWebview() {
    const config = vscode.workspace.getConfiguration('deviceScreenshot');
    this._view?.webview.postMessage({
      command: 'settingsUpdated',
      language: this.getLanguage(),
      saveDir: this.getSaveDirectory(),
      adbPath: config.get<string>('adbPath', ''),
      showStatusBar: config.get<boolean>('showStatusBarButton', true),
    });
  }

  public sendLaunchStateToWebview() {
    this._view?.webview.postMessage({
      command: 'launchStateUpdated',
      state: this._launchManager.getState(),
      offlineEmulators: this._offlineEmulators,
      runDeviceId: this._runDeviceId || null,
      extraRunTarget: this._extraRunTarget || null,
    });
  }

  public openSettingsDrawer() {
    this._view?.webview.postMessage({
      command: 'openSettingsModal',
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview();

    const watchDisposable = this._deviceManager.startWatching(1500);

    const changeSub = this._deviceManager.onDidChangeDevices(async (devices) => {
      this._devices = devices;
      // Screenshot selection remains strictly what the user clicked (or undefined if unplugged)
      if (this._selectedDevice) {
        this._selectedDevice = this._devices.find((d) => d.id === this._selectedDevice!.id);
      }

      // Run target selection updates independently for the Run spinner
      await this.resolveRunDeviceSelection();

      this._view?.webview.postMessage({
        command: 'devicesUpdated',
        devices: this._devices,
        offlineEmulators: this._offlineEmulators,
        selectedDeviceId: this._selectedDevice?.id || null,
        runDeviceId: this._runDeviceId || null,
        extraRunTarget: this._extraRunTarget || null,
      });
    });

    const launchSub = this._launchManager.onDidChangeState((state) => {
      this._view?.webview.postMessage({
        command: 'launchStateUpdated',
        state,
        offlineEmulators: this._offlineEmulators,
        runDeviceId: this._runDeviceId || null,
        extraRunTarget: this._extraRunTarget || null,
      });
    });

    webviewView.onDidDispose(() => {
      watchDisposable.dispose();
      changeSub.dispose();
      launchSub.dispose();
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'ready':
          this.sendSettingsToWebview();
          this.sendLaunchStateToWebview();
          await this.refreshDevices(false);
          break;

        case 'refreshDevices':
          await this.refreshDevices(true);
          break;

        case 'selectDevice': {
          // Strictly for Screenshot capture only!
          const found = this._devices.find((d) => d.id === msg.deviceId);
          if (found) {
            this._selectedDevice = found;
            await this.captureSelectedDevice();
          }
          break;
        }

        case 'selectRunDevice': {
          // Strictly for Run & Debug target spinner only!
          if (typeof msg.deviceId === 'string' && msg.deviceId) {
            this._runDeviceId = msg.deviceId;
            if (this._extraRunTarget && this._extraRunTarget.id !== msg.deviceId) {
              this._extraRunTarget = undefined;
            }
            await this._context.workspaceState.update(RUN_DEVICE_STATE_KEY, msg.deviceId);
            if (!msg.deviceId.startsWith('offline:')) {
              void this._launchManager.syncIdeSelectedDeviceById(msg.deviceId);
            }
          }
          break;
        }

        case 'selectIdeDevice': {
          const pickedId = await this._launchManager.openIdeDevicePicker();
          this._devices = await this._deviceManager.listDevices();
          if (this._selectedDevice) {
            this._selectedDevice = this._devices.find((d) => d.id === this._selectedDevice!.id);
          }
          this._offlineEmulators = await this._deviceManager.listOfflineEmulators(this._devices);
          if (pickedId) {
            const matched = this._devices.find((d) => d.id.toLowerCase() === pickedId.toLowerCase());
            if (matched) {
              this._runDeviceId = matched.id;
              this._extraRunTarget = undefined;
            } else {
              this._runDeviceId = pickedId;
              this._extraRunTarget = { id: pickedId, label: pickedId };
            }
            await this._context.workspaceState.update(RUN_DEVICE_STATE_KEY, this._runDeviceId);
          } else {
            await this.resolveRunDeviceSelection();
          }
          this._view?.webview.postMessage({
            command: 'devicesUpdated',
            devices: this._devices,
            offlineEmulators: this._offlineEmulators,
            selectedDeviceId: this._selectedDevice?.id || null,
            runDeviceId: this._runDeviceId || null,
            extraRunTarget: this._extraRunTarget || null,
            launchState: this._launchManager.getState(),
          });
          break;
        }

        case 'selectLaunchConfig': {
          if (typeof msg.key === 'string') {
            await this._launchManager.setSelectedKey(msg.key);
          }
          break;
        }

        case 'runLaunch': {
          let requestedRunId =
            typeof msg.runDeviceId === 'string' && msg.runDeviceId && msg.runDeviceId !== '__none__'
              ? msg.runDeviceId
              : this._runDeviceId;

          // If an offline emulator/simulator is selected, boot it first and then launch!
          if (requestedRunId && requestedRunId.startsWith('offline:')) {
            const offlineItem = this._offlineEmulators.find((o) => o.id === requestedRunId);
            const label = offlineItem
              ? `${offlineItem.name}${offlineItem.coldBoot ? ' (cold boot)' : ''}`
              : '';
            const booted = await this._deviceManager.bootOfflineEmulator(
              requestedRunId,
              `${this.t('bootingEmulator')} ${label}`
            );
            if (!booted) {
              return;
            }
            this._devices = await this._deviceManager.listDevices();
            this._offlineEmulators = await this._deviceManager.listOfflineEmulators(this._devices);
            requestedRunId = booted.id;
            this._runDeviceId = booted.id;
            await this._context.workspaceState.update(RUN_DEVICE_STATE_KEY, this._runDeviceId);
            this._view?.webview.postMessage({
              command: 'devicesUpdated',
              devices: this._devices,
              offlineEmulators: this._offlineEmulators,
              selectedDeviceId: this._selectedDevice?.id || null,
              runDeviceId: this._runDeviceId,
              extraRunTarget: this._extraRunTarget || null,
            });
          }

          const res = await this._launchManager.startLaunch({
            selectedKey: typeof msg.key === 'string' ? msg.key : undefined,
            targetDeviceId: requestedRunId,
            availableDevices: this._devices,
            noDebug: !!msg.noDebug,
            pickDevicePlaceholder: this.t('selectRunDeviceTitle'),
          });
          if (res.chosenDeviceId && res.chosenDeviceId !== this._runDeviceId) {
            this._runDeviceId = res.chosenDeviceId;
            await this._context.workspaceState.update(RUN_DEVICE_STATE_KEY, this._runDeviceId);
            this._view?.webview.postMessage({
              command: 'devicesUpdated',
              devices: this._devices,
              offlineEmulators: this._offlineEmulators,
              selectedDeviceId: this._selectedDevice?.id || null,
              runDeviceId: this._runDeviceId || null,
              extraRunTarget: this._extraRunTarget || null,
            });
          }
          break;
        }

        case 'hotReload':
          await this._launchManager.hotReload();
          break;

        case 'hotRestart':
          await this._launchManager.hotRestart();
          break;

        case 'stopDebug':
          await this._launchManager.stopDebug(this._runDeviceId);
          break;

        case 'recapture':
          await this.captureSelectedDevice();
          break;

        case 'copyToClipboard':
          await this.copyDataUrlToClipboard(msg.dataUrl, true);
          break;

        case 'sendToPrompt':
          await this.sendDataUrlToPrompt(msg.dataUrl);
          break;

        case 'saveImage':
          await this.saveDataUrlToFile(msg.dataUrl, false);
          break;

        case 'saveImageAs':
          await this.saveDataUrlToFile(msg.dataUrl, true);
          break;

        case 'configureSaveDir':
          await this.configureSaveDir();
          break;

        case 'saveCustomColors': {
          if (Array.isArray(msg.colors)) {
            await this._context.globalState.update('customMarkupColors', msg.colors.slice(0, 3));
          }
          break;
        }

        case 'updateSettings': {
          const config = vscode.workspace.getConfiguration('deviceScreenshot');
          if (typeof msg.language === 'string') {
            await config.update('language', msg.language, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.adbPath === 'string') {
            await config.update('adbPath', msg.adbPath.trim(), vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.showStatusBar === 'boolean') {
            await config.update('showStatusBarButton', msg.showStatusBar, vscode.ConfigurationTarget.Global);
          }
          this.sendSettingsToWebview();
          this._view?.webview.postMessage({
            command: 'toast',
            text: this.t('toastSettingsSaved'),
          });
          break;
        }

        case 'openIdeSettings': {
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:etoxiuq.device-screenshot');
          break;
        }

        case 'openInLargeTab':
          if (this._selectedDevice) {
            await ScreenshotPanel.createOrShow(
              this._context,
              this._deviceManager,
              this._selectedDevice,
              this._devices,
              msg.dataUrl
            );
          }
          break;
      }
    });
  }

  private getCustomColors(): string[] {
    return this._context.globalState.get<string[]>('customMarkupColors', []);
  }

  public async refreshDevices(_keepSelection = true) {
    this._view?.webview.postMessage({ command: 'scanningDevices' });
    this._devices = await this._deviceManager.listDevices();

    // Screenshot selection stays strictly what the user clicked in Connected Devices
    if (this._selectedDevice) {
      this._selectedDevice = this._devices.find((d) => d.id === this._selectedDevice!.id);
    }

    // Run target selection is independent and backs the Run Device Spinner
    await this.resolveRunDeviceSelection();

    const config = vscode.workspace.getConfiguration('deviceScreenshot');
    this._view?.webview.postMessage({
      command: 'devicesUpdated',
      devices: this._devices,
      offlineEmulators: this._offlineEmulators,
      selectedDeviceId: this._selectedDevice?.id || null,
      runDeviceId: this._runDeviceId || null,
      extraRunTarget: this._extraRunTarget || null,
      launchState: this._launchManager.getState(),
      saveDir: this.getSaveDirectory(),
      customColors: this.getCustomColors(),
      language: this.getLanguage(),
      adbPath: config.get<string>('adbPath', ''),
      showStatusBar: config.get<boolean>('showStatusBarButton', true),
    });
  }

  public hasSelectedDevice(): boolean {
    return !!this._selectedDevice;
  }

  public async captureSelectedDevice() {
    if (!this._selectedDevice) {
      this._view?.webview.postMessage({
        command: 'toast',
        text: this.t('toastSelectDeviceFirst'),
      });
      return;
    }

    this._view?.webview.postMessage({
      command: 'capturing',
      device: this._selectedDevice,
    });

    try {
      const buffer = await this._deviceManager.captureScreenshot(this._selectedDevice);
      const base64 = buffer.toString('base64');
      this._view?.webview.postMessage({
        command: 'captured',
        base64,
        byteLength: buffer.byteLength,
        device: this._selectedDevice,
        saveDir: this.getSaveDirectory(),
      });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this._view?.webview.postMessage({
        command: 'captureError',
        error: errMsg,
      });
    }
  }

  private getSaveDirectory(): string {
    const configDir = vscode.workspace
      .getConfiguration('deviceScreenshot')
      .get<string>('defaultSaveDirectory', '')
      .trim();
    if (configDir && fs.existsSync(configDir)) {
      return configDir;
    }
    const saved = this._context.globalState.get<string>('saveDirectory');
    if (saved && fs.existsSync(saved)) {
      return saved;
    }
    const desktop = path.join(os.homedir(), 'Desktop');
    return fs.existsSync(desktop) ? desktop : os.homedir();
  }

  private async configureSaveDir() {
    const currentDir = this.getSaveDirectory();
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(currentDir),
      openLabel: 'Select Save Folder',
    });
    if (uris && uris.length > 0) {
      const selectedPath = uris[0].fsPath;
      await this._context.globalState.update('saveDirectory', selectedPath);
      await vscode.workspace
        .getConfiguration('deviceScreenshot')
        .update('defaultSaveDirectory', selectedPath, vscode.ConfigurationTarget.Global);
      this._view?.webview.postMessage({
        command: 'saveDirUpdated',
        saveDir: selectedPath,
      });
    }
  }

  private async writeClipboardNative(pngFilePath: string): Promise<void> {
    if (process.platform === 'darwin') {
      await new Promise<void>((resolve, reject) => {
        cp.execFile(
          'osascript',
          ['-e', `set the clipboard to (read (POSIX file "${pngFilePath}") as «class PNGf»)`],
          (err) => (err ? reject(err) : resolve())
        );
      });
    } else if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        cp.execFile(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${pngFilePath}'))`,
          ],
          (err) => (err ? reject(err) : resolve())
        );
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        cp.execFile('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', pngFilePath], (err) =>
          err ? reject(err) : resolve()
        );
      });
    }
  }

  private async copyDataUrlToClipboard(dataUrl: string, showToast = true): Promise<string> {
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const promptDir = path.join(os.tmpdir(), 'antigravity-device-screenshots');
    await fs.promises.mkdir(promptDir, { recursive: true });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeModel = (this._selectedDevice?.model || 'device').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(promptDir, `Screenshot_${timestamp}_${safeModel}.png`);

    await fs.promises.writeFile(filePath, buffer);
    await this.writeClipboardNative(filePath);

    if (showToast) {
      this._view?.webview.postMessage({
        command: 'toast',
        text: this.t('toastCopied'),
      });
    }

    return filePath;
  }

  private async sendDataUrlToPrompt(dataUrl: string) {
    try {
      const filePath = await this.copyDataUrlToClipboard(dataUrl, false);
      const res = await sendImageFileToActivePrompt(this._context, filePath);

      this._view?.webview.postMessage({
        command: 'toast',
        text: res.attached ? this.t('toastPromptAttached') : this.t('toastPromptFocused'),
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to send to prompt: ${err?.message || err}`);
    }
  }

  private async saveDataUrlToFile(dataUrl: string, showSaveAs: boolean) {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
        now.getHours()
      )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const safeModel = (this._selectedDevice?.model || 'device').replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `Screenshot_${timestamp}_${safeModel}.png`;

      let targetPath = path.join(this.getSaveDirectory(), fileName);

      if (showSaveAs) {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(targetPath),
          filters: { 'PNG Images': ['png'] },
        });
        if (!uri) {
          return;
        }
        targetPath = uri.fsPath;
      }

      await fs.promises.writeFile(targetPath, buffer);
      this._view?.webview.postMessage({
        command: 'toast',
        text: `${this.t('toastSaved')}${path.basename(targetPath)}`,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save file: ${err?.message || err}`);
    }
  }

  private _getHtmlForWebview(): string {
    const i18nJson = JSON.stringify(TRANSLATIONS);
    const initialLang = this.getLanguage();
    const languageOptionsHtml = LANGUAGE_OPTIONS.map(
      (opt) => `<option value="${opt.code}">${opt.label}</option>`
    ).join('\n          ');

    return /* html */ `<!DOCTYPE html>
<html lang="${initialLang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg-main: var(--vscode-sideBar-background, #1e1f22);
      --bg-card: var(--vscode-editorWidget-background, #2b2d30);
      --bg-card-hover: var(--vscode-list-hoverBackground, #35373b);
      --bg-active: rgba(53, 116, 240, 0.22);
      --border: var(--vscode-panel-border, #3c3e43);
      --text: var(--vscode-foreground, #dfe1e5);
      --text-muted: var(--vscode-descriptionForeground, #9da0a8);
      --accent: #3574f0;
      --accent-hover: #4682fa;
    }

    * {
      box-sizing: border-box;
      user-select: none;
    }

    body {
      margin: 0;
      padding: 0;
      background: var(--bg-main);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12.5px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }

    svg {
      display: block;
      flex-shrink: 0;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 6px 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .icon-btn {
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 4px 6px;
      cursor: pointer;
      font-size: 11.5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.12s;
    }

    .icon-btn:hover:not(:disabled) {
      background: var(--bg-card-hover);
      border-color: var(--border);
    }

    .icon-btn.active {
      background: rgba(53, 116, 240, 0.28);
      border-color: var(--accent);
      color: #ffffff;
    }

    .icon-btn:disabled, .btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    #refreshBtn {
      color: #4ac26b;
      background: rgba(46, 160, 67, 0.18);
      border: 1px solid rgba(46, 160, 67, 0.44);
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 5px;
      text-transform: none;
      letter-spacing: 0;
    }

    #refreshBtn:hover:not(:disabled) {
      background: rgba(46, 160, 67, 0.32);
      border-color: rgba(74, 194, 107, 0.7);
      color: #6ee787;
    }

    /* Device List */
    .device-list {
      max-height: 130px;
      overflow-y: auto;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .device-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-radius: 6px;
      background: var(--bg-card);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .device-item:hover {
      background: var(--bg-card-hover);
    }

    .device-item.selected {
      background: var(--bg-active);
      border-color: var(--accent);
    }

    .device-info {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .device-icon {
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .device-item.selected .device-icon {
      color: #548af7;
    }

    .device-text {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .device-name {
      font-weight: 600;
      font-size: 12.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .device-sub {
      font-size: 10.5px;
      color: var(--text-muted);
    }

    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 10px;
      font-weight: 600;
      flex-shrink: 0;
    }

    .badge-physical,
    .badge-usb {
      background: rgba(46, 160, 67, 0.18);
      color: #4ac26b;
      border: 1px solid rgba(46, 160, 67, 0.38);
    }

    .badge-wifi {
      background: rgba(56, 139, 253, 0.18);
      color: #58a6ff;
      border: 1px solid rgba(56, 139, 253, 0.38);
    }

    .badge-sim {
      background: rgba(157, 160, 168, 0.15);
      color: var(--text-muted);
    }

    .empty-devices {
      padding: 12px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }

    /* Quick Action Buttons */
    .quick-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 8px 10px 6px 10px;
      flex-shrink: 0;
    }

    .btn {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.12s, border-color 0.12s;
    }

    .btn:hover:not(:disabled) {
      background: var(--bg-card-hover);
    }

    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .btn-prompt {
      grid-column: 1 / -1;
      background: #3574f0;
      border: 1px solid #4682fa;
      color: #ffffff;
      padding: 7px 10px;
      font-size: 12.5px;
    }

    .btn-prompt:hover:not(:disabled) {
      background: #4682fa;
    }

    /* 2-Row High-Clarity Markup & Color Card */
    .markup-card {
      margin: 0 8px 5px 8px;
      background: #25262a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
      position: relative;
    }

    .markup-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }

    .markup-row-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.06);
      margin: 0 -2px;
    }

    .markup-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .tool-btn {
      width: 28px;
      height: 26px;
      padding: 0;
      border-radius: 6px;
      color: #cfd2d9;
    }

    .tool-btn:hover:not(:disabled) {
      color: #ffffff;
      background: #35373c;
    }

    .tool-btn.active {
      background: rgba(53, 116, 240, 0.3);
      border-color: #4682fa;
      color: #ffffff;
    }

    .v-sep {
      width: 1px;
      height: 16px;
      background: var(--border);
      margin: 0 4px;
    }

    /* Color Swatches & Picker */
    .color-palette {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }

    .color-dot {
      width: 17px;
      height: 17px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.3);
      cursor: pointer;
      padding: 0;
      transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
      position: relative;
    }

    .color-dot:hover {
      transform: scale(1.1);
    }

    .color-dot.active {
      border-color: #ffffff;
      transform: scale(1.18);
      box-shadow: 0 0 0 2px rgba(53, 116, 240, 0.75);
    }

    .custom-colors-group {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: #1b1c1f;
      border: 1px solid #3a3c42;
      border-radius: 6px;
      padding: 2px 6px;
    }

    .custom-colors-container {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .color-dot.custom-dot {
      border-radius: 4px;
      width: 16px;
      height: 16px;
    }

    .custom-slot-empty {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      border: 1px dashed #4e5157;
      background: rgba(255, 255, 255, 0.02);
      cursor: pointer;
      padding: 0;
      transition: border-color 0.12s, background 0.12s;
    }

    .custom-slot-empty:hover {
      border-color: #8c9099;
      background: rgba(255, 255, 255, 0.06);
    }

    .picker-trigger-btn {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 1.5px dashed #8c9099;
      background: conic-gradient(
        from 0deg,
        #ff3b30,
        #ffcc00,
        #34c759,
        #007aff,
        #af52de,
        #ff3b30
      );
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      transition: transform 0.12s, border-color 0.12s;
    }

    .picker-trigger-btn:hover {
      transform: scale(1.12);
      border-color: #ffffff;
      border-style: solid;
    }

    .picker-trigger-inner {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #25262a;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }

    /* Color Picker Popover */
    .color-picker-popover {
      position: absolute;
      top: calc(100% + 4px);
      left: 8px;
      background: #2b2d30;
      border: 1px solid #4e5157;
      border-radius: 8px;
      padding: 8px 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
      display: none;
      flex-direction: column;
      gap: 6px;
      z-index: 50;
      min-width: 215px;
    }

    .color-picker-popover.visible {
      display: flex;
    }

    .picker-popover-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .picker-controls-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .native-color-well {
      width: 28px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: none;
      cursor: pointer;
    }

    .hex-input {
      background: #1e1f22;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 4px 7px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      width: 86px;
      outline: none;
      text-transform: uppercase;
    }

    .hex-input:focus {
      border-color: var(--accent);
    }

    /* Visual Stroke Size Dots (Side-by-Side) */
    .stroke-size-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      background: #1b1c1f;
      border: 1px solid #3a3c42;
      border-radius: 6px;
      padding: 2px 3px;
    }

    .stroke-size-btn {
      width: 22px;
      height: 20px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: transparent;
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s, border-color 0.12s;
    }

    .stroke-size-btn:hover {
      background: #303238;
    }

    .stroke-size-btn.active {
      background: rgba(53, 116, 240, 0.28);
      border-color: var(--accent);
    }

    .stroke-dot-circle {
      border-radius: 50%;
      background: #dfe1e5;
      display: block;
      transition: width 0.15s ease, height 0.15s ease, background 0.15s ease, border 0.15s ease;
    }

    .stroke-size-btn.active .stroke-dot-circle {
      background: #ffffff;
    }

    .stroke-size-group.eraser-mode .stroke-dot-circle {
      background: rgba(255, 59, 48, 0.25);
      border: 2px solid #ffffff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
    }

    .stroke-size-group.eraser-mode .stroke-size-btn.active .stroke-dot-circle {
      background: rgba(53, 116, 240, 0.45);
      border-color: #ffffff;
    }

    .stroke-size-group.eraser-mode .stroke-size-btn[data-size="3"] .stroke-dot-circle {
      width: 9px !important;
      height: 9px !important;
    }
    .stroke-size-group.eraser-mode .stroke-size-btn[data-size="6"] .stroke-dot-circle {
      width: 13px !important;
      height: 13px !important;
    }
    .stroke-size-group.eraser-mode .stroke-size-btn[data-size="10"] .stroke-dot-circle {
      width: 17px !important;
      height: 17px !important;
    }

    /* Compact Tools Row */
    .tools-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      padding: 2px 10px 6px 10px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .tool-group {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .select-mini {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 5px;
      font-size: 11px;
      outline: none;
      cursor: pointer;
    }

    /* Viewport */
    .viewport {
      flex: 1;
      background: #121315;
      margin: 4px 8px 8px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 60px;
    }

    .viewport.mode-pan { cursor: grab; }
    .viewport.mode-pan.dragging { cursor: grabbing; }
    .viewport.mode-draw { cursor: crosshair; }
    .viewport.mode-text { cursor: text; }

    /* Empty Unselected State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px 16px;
      color: var(--text-muted);
      gap: 10px;
    }

    .empty-state-icon {
      width: 46px;
      height: 46px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
    }

    .empty-state-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }

    .empty-state-desc {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text-muted);
    }

    .canvas-wrapper {
      position: relative;
      transform-origin: center center;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.65);
      line-height: 0;
      display: none;
    }

    .canvas-wrapper.visible {
      display: block;
    }

    canvas {
      display: block;
    }

    .grid-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      display: none;
      background-size: 20px 20px;
      background-image:
        linear-gradient(to right, rgba(255, 255, 255, 0.12) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.12) 1px, transparent 1px);
    }

    .grid-overlay.visible {
      display: block;
    }

    .floating-text-input {
      position: absolute;
      display: none;
      background: rgba(20, 21, 23, 0.9);
      color: #fff;
      border: 1.5px solid var(--accent);
      border-radius: 4px;
      padding: 3px 6px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 700;
      font-size: 14px;
      outline: none;
      z-index: 25;
      min-width: 90px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }

    .crop-confirm-bar {
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 31, 34, 0.96);
      border: 1px solid var(--accent);
      border-radius: 20px;
      padding: 4px 10px;
      display: none;
      align-items: center;
      gap: 6px;
      z-index: 22;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
    }

    .crop-confirm-bar.visible {
      display: flex;
    }

    .meta-overlay {
      position: absolute;
      top: 6px;
      right: 8px;
      background: rgba(16, 18, 22, 0.36);
      backdrop-filter: blur(1.5px);
      -webkit-backdrop-filter: blur(1.5px);
      color: #eef0f4;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.16);
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 10.5px;
      pointer-events: none;
      font-variant-numeric: tabular-nums;
      display: none;
    }

    .meta-overlay.visible {
      display: block;
    }

    .zoom-overlay {
      position: absolute;
      bottom: 6px;
      right: 6px;
      max-width: calc(100% - 12px);
      display: none;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 2px;
      background: rgba(16, 18, 22, 0.34);
      backdrop-filter: blur(1.5px);
      -webkit-backdrop-filter: blur(1.5px);
      padding: 2px 4px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
      transition: background 0.15s ease, border-color 0.15s ease;
      z-index: 20;
    }

    .zoom-overlay:hover {
      background: rgba(16, 18, 22, 0.56);
      border-color: rgba(255, 255, 255, 0.3);
    }

    .zoom-overlay.visible {
      display: flex;
    }

    .hud-btn {
      width: 22px;
      height: 22px;
      padding: 0;
      border-radius: 4px;
      border: 1px solid transparent;
      background: transparent;
      color: #f4f6fa;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.88);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 10px;
      font-weight: 600;
      transition: all 0.12s ease;
    }

    .hud-btn svg {
      filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.85));
    }

    .hud-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.18);
      color: #ffffff;
    }

    .hud-btn.active {
      background: rgba(53, 116, 240, 0.48);
      border-color: var(--accent);
      color: #ffffff;
    }

    .hud-select {
      height: 20px;
      background: rgba(16, 18, 22, 0.28);
      color: #f4f6fa;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 4px;
      padding: 0 3px;
      font-size: 10.5px;
      font-weight: 600;
      outline: none;
      cursor: pointer;
    }

    .hud-select option {
      background: #1e1f22;
      color: #dfe1e5;
    }

    .hud-sep {
      width: 1px;
      height: 13px;
      background: rgba(255, 255, 255, 0.28);
      margin: 0 2px;
    }

    .loading-overlay {
      position: absolute;
      inset: 0;
      background: rgba(18, 19, 21, 0.82);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      z-index: 30;
    }

    .loading-overlay.visible {
      display: flex;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2.5px solid rgba(255, 255, 255, 0.15);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .toast {
      position: absolute;
      bottom: 38px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: rgba(43, 45, 48, 0.96);
      border: 1px solid var(--border);
      color: #fff;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
      opacity: 0;
      pointer-events: none;
      transition: all 0.18s ease;
      z-index: 40;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* Above-Viewport Single-Row Action Controls */
    .capture-action-bar {
      margin: 0 8px 2px 8px;
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }

    .btn-icon-action {
      width: 28px;
      height: 28px;
      padding: 0;
      flex: 0 0 28px;
      border-radius: 6px;
    }

    #recaptureBtn {
      width: 30px;
      flex: 0 0 30px;
    }

    #recaptureBtn:not(:disabled) {
      color: #4ac26b;
      background: rgba(46, 160, 67, 0.18);
      border-color: rgba(46, 160, 67, 0.45);
    }

    #recaptureBtn:hover:not(:disabled) {
      background: rgba(46, 160, 67, 0.32);
      border-color: rgba(74, 194, 107, 0.7);
      color: #6ee787;
    }

    .btn-prompt-inline {
      flex: 1;
      min-width: 0;
      height: 28px;
      background: #3574f0;
      border: 1px solid #4682fa;
      color: #ffffff;
      padding: 0 10px;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .btn-prompt-inline:hover:not(:disabled) {
      background: #4682fa;
    }

    .hidden-save-meta {
      display: none;
    }

    .link-btn {
      background: none;
      border: none;
      color: #548af7;
      font-size: 11px;
      cursor: pointer;
      padding: 0;
      flex-shrink: 0;
    }

    .link-btn:hover {
      text-decoration: underline;
    }

    .save-buttons {
      display: flex;
      gap: 6px;
    }

    /* Settings Overlay Modal */
    .settings-modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(12, 13, 15, 0.78);
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding: 16px 10px;
      z-index: 100;
    }

    .settings-modal-backdrop.visible {
      display: flex;
    }

    .settings-modal {
      width: 100%;
      max-width: 340px;
      background: #25262a;
      border: 1px solid #4a4d54;
      border-radius: 10px;
      padding: 12px 14px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.7);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .settings-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 700;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .settings-field-label {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text);
    }

    .settings-input, .settings-select {
      background: #1b1c1f;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
      width: 100%;
    }

    .settings-input:focus, .settings-select:focus {
      border-color: var(--accent);
    }

    .settings-row-inline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .settings-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }

    /* Compact Top Run & Debug Card (Separated from Screenshot Device List) */
    .run-card {
      margin: 5px 8px 6px 8px;
      padding: 5px 6px;
      background: #25262a;
      border: 1px solid var(--border);
      border-radius: 7px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex-shrink: 0;
      transition: border-color 0.15s ease;
    }

    .run-card.running {
      border-color: rgba(74, 194, 107, 0.5);
    }

    .run-row {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 24px;
    }

    .run-device-prefix {
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      flex-shrink: 0;
    }

    .run-card.running .run-device-prefix {
      color: #4ac26b;
    }

    .run-flavor-icon {
      display: block;
    }

    .run-status-dot {
      display: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4ac26b;
      box-shadow: 0 0 6px rgba(74, 194, 107, 0.85);
      flex-shrink: 0;
    }

    .run-card.running .run-flavor-icon {
      display: none;
    }

    .run-card.running .run-status-dot {
      display: inline-block;
    }

    .run-select {
      flex: 1;
      min-width: 0;
      height: 24px;
      background: #1b1c1f;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 0 6px;
      font-size: 11.5px;
      font-weight: 500;
      outline: none;
      cursor: pointer;
    }

    .run-select:focus {
      border-color: var(--accent);
    }

    .run-icon-btn {
      width: 25px;
      height: 24px;
      padding: 0;
      border-radius: 5px;
      border: 1px solid transparent;
      background: transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.12s ease;
    }

    .run-icon-btn.play {
      color: #4ac26b;
      background: rgba(46, 160, 67, 0.16);
      border-color: rgba(46, 160, 67, 0.36);
    }

    .run-icon-btn.play:hover {
      background: rgba(46, 160, 67, 0.28);
      color: #6ee787;
    }

    .run-card.running #runDebugBtn {
      display: none;
    }

    .run-card.running.can-launch-another #runDebugBtn {
      display: inline-flex;
    }

    .debug-active-group {
      display: none;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }

    .run-card.running .debug-active-group {
      display: inline-flex;
    }

    .run-icon-btn.reload {
      color: #f2b94b;
    }

    .run-icon-btn.reload:hover {
      background: rgba(242, 185, 75, 0.18);
      border-color: rgba(242, 185, 75, 0.36);
    }

    .run-icon-btn.restart {
      color: #58a6ff;
    }

    .run-icon-btn.restart:hover {
      background: rgba(88, 166, 255, 0.18);
      border-color: rgba(88, 166, 255, 0.36);
    }

    .run-icon-btn.stop {
      color: #f85149;
      background: rgba(248, 81, 73, 0.12);
      border-color: rgba(248, 81, 73, 0.28);
    }

    .run-icon-btn.stop:hover {
      background: rgba(248, 81, 73, 0.24);
    }
  </style>
</head>
<body>
  <!-- 0. Top Run & Debug Section (Independent Target Device Spinner + Flavor Spinner) -->
  <div class="section-header" style="padding: 5px 10px 3px 12px;">
    <span id="lblRunAndDebug">Run & Debug</span>
    <div class="header-actions">
      <button id="openTabBtn" class="icon-btn" disabled title="Expand">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9.5 2.5h4v4"/>
          <path d="M13.5 2.5L8 8"/>
          <path d="M6.5 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/>
        </svg>
      </button>
      <button id="openSettingsBtn" class="icon-btn" title="Settings">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="2.2"/>
          <path d="M13.4 9.3a1.2 1.2 0 0 0 .2 1.3l.1.1a1.4 1.4 0 1 1-2 2l-.1-.1a1.2 1.2 0 0 0-1.3-.2 1.2 1.2 0 0 0-.7 1.1v.2a1.4 1.4 0 1 1-2.8 0v-.1a1.2 1.2 0 0 0-.8-1.1 1.2 1.2 0 0 0-1.3.2l-.1.1a1.4 1.4 0 1 1-2-2l.1-.1a1.2 1.2 0 0 0 .2-1.3 1.2 1.2 0 0 0-1.1-.7h-.2a1.4 1.4 0 1 1 0-2.8h.1a1.2 1.2 0 0 0 1.1-.8 1.2 1.2 0 0 0-.2-1.3l-.1-.1a1.4 1.4 0 1 1 2-2l.1.1a1.2 1.2 0 0 0 1.3.2h.1a1.2 1.2 0 0 0 .7-1.1v-.2a1.4 1.4 0 1 1 2.8 0v.1a1.2 1.2 0 0 0 .7 1.1 1.2 1.2 0 0 0 1.3-.2l.1-.1a1.4 1.4 0 1 1 2 2l-.1.1a1.2 1.2 0 0 0-.2 1.3v.1a1.2 1.2 0 0 0 1.1.7h.2a1.4 1.4 0 1 1 0 2.8h-.1a1.2 1.2 0 0 0-1.1.7z"/>
        </svg>
      </button>
    </div>
  </div>
  <div id="runBar" class="run-card">
    <div class="run-row">
      <span class="run-device-prefix">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="1.5" width="8" height="13" rx="1.6"/>
          <line x1="6.8" y1="12.3" x2="9.2" y2="12.3"/>
        </svg>
      </span>
      <select id="runDeviceSelect" class="run-select" title="Target Device for Run & Debug">
        <option value="__none__">No Target Device</option>
      </select>
    </div>
    <div class="run-row">
      <span class="run-device-prefix">
        <svg class="run-flavor-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="8 1.8 14 5.2 8 8.6 2 5.2 8 1.8"/>
          <polyline points="2 8.2 8 11.6 14 8.2"/>
          <polyline points="2 11.1 8 14.5 14 11.1"/>
        </svg>
        <span id="runStatusDot" class="run-status-dot"></span>
      </span>
      <select id="launchConfigSelect" class="run-select" title="Select Launch Config / Flavor">
        <option value="__default__">Default (Current App)</option>
      </select>
      <button id="runDebugBtn" class="run-icon-btn play" title="Run & Debug">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.2 2.6a.8.8 0 0 1 1.2-.7l8 5.4a.8.8 0 0 1 0 1.4l-8 5.4a.8.8 0 0 1-1.2-.7V2.6z"/>
        </svg>
      </button>
      <div id="debugActiveControls" class="debug-active-group">
        <button id="hotReloadBtn" class="run-icon-btn reload" title="Hot Reload">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.3 1.5L3.5 9h4.1l-.9 5.5L12.5 7H8.4l.9-5.5z"/>
          </svg>
        </button>
        <button id="hotRestartBtn" class="run-icon-btn restart" title="Hot Restart">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
            <path d="M13.5 2v2.5H11"/>
          </svg>
        </button>
        <button id="stopDebugBtn" class="run-icon-btn stop" title="Stop">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2.5" y="2.5" width="11" height="11" rx="1.8"/>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <!-- 1. Connected Devices Header & List (Screenshot Capture) -->
  <div class="section-header" style="padding: 5px 10px 4px 12px; border-top: 1px solid var(--border);">
    <span id="lblConnectedDevices">Connected Devices</span>
    <div class="header-actions">
      <button id="refreshBtn" class="icon-btn" title="Refresh Devices">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
          <path d="M13.5 2v2.5H11"/>
        </svg>
        <span id="lblRefresh">Refresh</span>
      </button>
    </div>
  </div>
  <div id="deviceList" class="device-list" style="margin-bottom: 6px;">
    <div class="empty-devices">Scanning connected devices...</div>
  </div>

  <!-- 2. High-Clarity 2-Row Markup & Color Card -->
  <div class="markup-card">
    <!-- Row 1: Drawing & Crop Tools + Undo/Reset -->
    <div class="markup-row">
      <div class="markup-group">
        <button class="icon-btn tool-btn active" data-tool="pan" id="btnToolPan" title="Move / Pan">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 1.5v13M1.5 8h13"/>
            <path d="M6 3.5L8 1.5l2 2M6 12.5L8 14.5l2-2M3.5 6L1.5 8l2 2M12.5 6l2 2-2 2"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="pen" id="btnToolPen" title="Pen">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11.2 2.2a1.6 1.6 0 0 1 2.3 2.3L5.3 12.7 2 13.7l1-3.3 8.2-8.2z"/>
            <path d="M9.5 3.9l2.3 2.3"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="eraser" id="btnToolEraser" title="Eraser">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.8 2.5l4.7 4.7a1.4 1.4 0 0 1 0 2l-4.6 4.6H4.3L2.2 11.7a1.4 1.4 0 0 1 0-2L6.8 2.5a1.4 1.4 0 0 1 2 0z"/>
            <path d="M5.4 5.9l4.7 4.7"/>
            <line x1="8.5" y1="13.8" x2="14" y2="13.8"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="highlighter" id="btnToolHighlighter" title="Highlighter">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9.8 1.8l3.4 3.4-5.2 5.2H4.6V7l5.2-5.2z"/>
            <path d="M4.6 10.4L3 12h3.5l1.5-1.6"/>
            <line x1="2.5" y1="14.2" x2="13.5" y2="14.2" stroke-width="2.4" stroke-opacity="0.75"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="rect" id="btnToolRect" title="Rectangle">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.5"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="circle" id="btnToolCircle" title="Circle">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="8" cy="8" r="5.4"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="arrow" id="btnToolArrow" title="Arrow">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <line x1="2.8" y1="13.2" x2="12.2" y2="3.8"/>
            <polyline points="6.5 3.2 12.8 3.2 12.8 9.5"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="text" id="btnToolText" title="Text">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.5 3.5h9M8 3.5v9.5M5.8 13h4.4"/>
            <path d="M3.5 5.2V3.5M12.5 5.2V3.5" stroke-width="1.4"/>
          </svg>
        </button>

        <button class="icon-btn tool-btn" data-tool="crop" id="btnToolCrop" title="Crop">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.2 1.5v10.3h10.3"/>
            <path d="M1.5 4.2h10.3v10.3"/>
          </svg>
        </button>
      </div>

      <!-- Undo & Reset -->
      <div class="markup-group">
        <button id="undoBtn" class="icon-btn" disabled title="Undo (Cmd+Z)" style="padding: 4px 5px;">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h7a3.5 3.5 0 1 1 0 7H6"/>
            <path d="M5.5 3.5L3 6l2.5 2.5"/>
          </svg>
        </button>
        <button id="resetAllBtn" class="icon-btn" disabled title="Reset to Original" style="padding: 3px 6px; font-weight: 600;">
          Reset
        </button>
      </div>
    </div>

    <div class="markup-row-divider"></div>

    <!-- Row 2: Preset Colors + Divider + Custom Colors Tray (3 Slots + Picker) + Stroke Width -->
    <div class="markup-row">
      <div class="color-palette">
        <button class="color-dot preset-dot active" data-color="#ff3b30" style="background: #ff3b30;" title="#FF3B30"></button>
        <button class="color-dot preset-dot" data-color="#ffcc00" style="background: #ffcc00;" title="#FFCC00"></button>
        <button class="color-dot preset-dot" data-color="#34c759" style="background: #34c759;" title="#34C759"></button>
        <button class="color-dot preset-dot" data-color="#007aff" style="background: #007aff;" title="#007AFF"></button>
        <button class="color-dot preset-dot" data-color="#ffffff" style="background: #ffffff;" title="#FFFFFF"></button>

        <div class="v-sep" style="height: 14px; margin: 0 2px;"></div>

        <div class="custom-colors-group" title="Custom Colors (Max 3)">
          <div id="customColorsContainer" class="custom-colors-container"></div>
          <button id="colorPickerBtn" class="picker-trigger-btn" title="Add Custom Color">
            <span class="picker-trigger-inner">
              <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <line x1="5" y1="1.5" x2="5" y2="8.5"/>
                <line x1="1.5" y1="5" x2="8.5" y2="5"/>
              </svg>
            </span>
          </button>
        </div>
      </div>

      <div id="strokeSizeGroup" class="stroke-size-group">
        <button class="stroke-size-btn" data-size="3" id="btnStrokeThin" title="Thin">
          <span class="stroke-dot-circle" style="width: 4px; height: 4px;"></span>
        </button>
        <button class="stroke-size-btn active" data-size="6" id="btnStrokeMedium" title="Medium">
          <span class="stroke-dot-circle" style="width: 7px; height: 7px;"></span>
        </button>
        <button class="stroke-size-btn" data-size="10" id="btnStrokeThick" title="Thick">
          <span class="stroke-dot-circle" style="width: 11px; height: 11px;"></span>
        </button>
      </div>
    </div>

    <!-- Floating Color Picker Popover -->
    <div id="colorPickerPopover" class="color-picker-popover">
      <div class="picker-popover-title">
        <span id="lblCustomColorTitle">Custom Color (Max 3 saved)</span>
        <button id="closePickerBtn" class="icon-btn" style="padding: 1px 4px;">✕</button>
      </div>
      <div class="picker-controls-row">
        <input id="nativeColorInput" type="color" class="native-color-well" value="#ff5500" />
        <input id="hexColorInput" type="text" class="hex-input" value="#FF5500" maxlength="7" placeholder="#RRGGBB" />
        <button id="applyCustomColorBtn" class="btn btn-primary" style="padding: 4px 10px; font-size: 11.5px;">Apply</button>
      </div>
    </div>
  </div>

  <!-- 3. Always-Visible Single-Row Capture & Send Action Bar (Above Viewport) -->
  <div class="capture-action-bar">
    <button id="recaptureBtn" class="btn btn-icon-action" disabled title="Recapture (R)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
        <path d="M13.5 2v2.5H11"/>
      </svg>
    </button>
    <button id="copyBtn" class="btn btn-icon-action" disabled title="Copy to Clipboard (Cmd+C)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>
        <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/>
      </svg>
    </button>
    <button id="saveBtn" class="btn btn-icon-action" disabled title="Save (Cmd+S)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5"/>
        <path d="M2.5 13h11"/>
      </svg>
    </button>
    <button id="saveAsBtn" class="btn btn-icon-action" disabled title="Save As...">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/>
        <path d="M8 7v4M6 9h4"/>
      </svg>
    </button>
    <button id="sendPromptBtn" class="btn btn-prompt-inline" disabled title="Send to AI Prompt">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2L7.5 8.5"/>
        <path d="M14 2L9.5 14L7.5 8.5L2 6.5L14 2Z"/>
      </svg>
      <span id="lblSendToPrompt">Send to Prompt</span>
    </button>
  </div>

  <!-- 4. Live Screen Preview Area -->
  <div id="viewport" class="viewport mode-pan">
    <!-- Empty State -->
    <div id="emptyState" class="empty-state">
      <div class="empty-state-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="2" width="12" height="20" rx="2.5"/>
          <line x1="10" y1="19" x2="14" y2="19"/>
        </svg>
      </div>
      <div id="lblEmptyTitle" class="empty-state-title">Please select a device</div>
      <div id="lblEmptyDesc" class="empty-state-desc">
        Select a connected Android or iPhone device above<br/>
        to capture its screen and use markup or crop tools.
      </div>
    </div>

    <div id="canvasWrapper" class="canvas-wrapper">
      <canvas id="previewCanvas"></canvas>
      <div id="gridOverlay" class="grid-overlay"></div>
    </div>

    <input id="floatingTextInput" type="text" class="floating-text-input" placeholder="Enter text (Enter)" />

    <div id="cropConfirmBar" class="crop-confirm-bar">
      <span id="lblCropSelected" style="font-size: 11px; color: #dfe1e5;">Area selected</span>
      <button id="applyCropBtn" class="btn btn-primary" style="padding: 3px 10px; font-size: 11px;">Apply Crop</button>
      <button id="cancelCropBtn" class="btn" style="padding: 3px 8px; font-size: 11px;">Cancel</button>
    </div>

    <div id="metaOverlay" class="meta-overlay"></div>

    <!-- Bottom-Right Compact In-Screen Floating HUD (Transform + Scale + Zoom) -->
    <div id="zoomOverlay" class="zoom-overlay">
      <button id="rotateLeftBtn" class="hud-btn" disabled title="Rotate Left">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/>
          <path d="M2.5 2v2.5H5"/>
        </svg>
      </button>
      <button id="rotateRightBtn" class="hud-btn" disabled title="Rotate Right">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
          <path d="M13.5 2v2.5H11"/>
        </svg>
      </button>
      <button id="gridBtn" class="hud-btn" disabled title="Toggle Pixel Grid">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="2" y="2" width="12" height="12" rx="1"/>
          <line x1="6" y1="2" x2="6" y2="14"/>
          <line x1="10" y1="2" x2="10" y2="14"/>
          <line x1="2" y1="6" x2="14" y2="6"/>
          <line x1="2" y1="10" x2="14" y2="10"/>
        </svg>
      </button>
      <button id="shapeToggleBtn" class="hud-btn" disabled title="Rounded Corners">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3.8"/>
        </svg>
      </button>
      <select id="resolutionSelect" class="hud-select" disabled title="Resolution Scale">
        <option value="100">100%</option>
        <option value="75">75%</option>
        <option value="50">50%</option>
        <option value="25">25%</option>
      </select>
      <span class="hud-sep"></span>
      <button id="zoomOutBtn" class="hud-btn" title="Zoom Out">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><line x1="3" y1="8" x2="13" y2="8"/></svg>
      </button>
      <button id="fitBtn" class="hud-btn" title="Fit to Window">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>
        </svg>
      </button>
      <button id="actualBtn" class="hud-btn" title="1:1" style="width: 24px;">1:1</button>
      <button id="zoomInBtn" class="hud-btn" title="Zoom In">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
      </button>
    </div>

    <div id="loadingOverlay" class="loading-overlay">
      <div class="spinner"></div>
      <div id="loadingText">Capturing screen...</div>
    </div>

    <div id="toast" class="toast"></div>
  </div>

  <!-- Hidden Save Metadata Store (Configured via Settings Modal) -->
  <div class="hidden-save-meta">
    <span id="lblSaveLocation">Save to:</span>
    <span id="saveDirText">~/Desktop</span>
    <button id="configureDirBtn">Configure</button>
  </div>

  <!-- 7. Settings Overlay Modal -->
  <div id="settingsModalBackdrop" class="settings-modal-backdrop">
    <div class="settings-modal">
      <div class="settings-modal-header">
        <span id="lblSettingsTitle">Extension Settings</span>
        <button id="closeSettingsModalBtn" class="icon-btn">✕</button>
      </div>

      <div class="settings-field">
        <label id="lblLanguage" class="settings-field-label">Language</label>
        <select id="settingsLanguageSelect" class="settings-select">
          ${languageOptionsHtml}
        </select>
      </div>

      <div class="settings-field">
        <label id="lblSaveDirSetting" class="settings-field-label">Default Save Folder</label>
        <div class="settings-row-inline">
          <input id="settingsSaveDirInput" type="text" class="settings-input" readonly />
          <button id="settingsBrowseDirBtn" class="btn" style="flex-shrink: 0;">Configure</button>
        </div>
      </div>

      <div class="settings-field">
        <label id="lblAdbPathSetting" class="settings-field-label">Custom ADB Path (Optional)</label>
        <input id="settingsAdbPathInput" type="text" class="settings-input" placeholder="Auto-detect if empty" />
      </div>

      <div class="settings-row-inline">
        <label id="lblStatusBarSetting" class="settings-field-label" style="cursor: pointer;" for="settingsStatusBarCheck">Show Status Bar Button</label>
        <input id="settingsStatusBarCheck" type="checkbox" checked style="cursor: pointer;" />
      </div>

      <div class="settings-footer">
        <button id="openIdeSettingsLink" class="link-btn">IDE Settings...</button>
        <button id="saveSettingsBtn" class="btn btn-primary" style="padding: 5px 14px;">Apply</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const I18N = ${i18nJson};
    let currentLang = '${initialLang}';

    function t(key) {
      return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
    }

    const SVG_PHONE = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="1.5" width="8" height="13" rx="1.8"/><line x1="6.8" y1="12.5" x2="9.2" y2="12.5"/></svg>';
    const SVG_SIM = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="8.5" rx="1.2"/><line x1="5" y1="13.5" x2="11" y2="13.5"/><line x1="8" y1="11" x2="8" y2="13.5"/></svg>';

    const deviceListEl = document.getElementById('deviceList');
    const runDeviceSelect = document.getElementById('runDeviceSelect');
    const refreshBtn = document.getElementById('refreshBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const runBar = document.getElementById('runBar');
    const runDebugBtn = document.getElementById('runDebugBtn');
    const launchConfigSelect = document.getElementById('launchConfigSelect');
    const hotReloadBtn = document.getElementById('hotReloadBtn');
    const hotRestartBtn = document.getElementById('hotRestartBtn');
    const stopDebugBtn = document.getElementById('stopDebugBtn');
    const recaptureBtn = document.getElementById('recaptureBtn');
    const copyBtn = document.getElementById('copyBtn');
    const sendPromptBtn = document.getElementById('sendPromptBtn');

    const toolBtns = document.querySelectorAll('.tool-btn');
    const presetDots = document.querySelectorAll('.preset-dot');
    const customColorsContainer = document.getElementById('customColorsContainer');
    const colorPickerBtn = document.getElementById('colorPickerBtn');
    const colorPickerPopover = document.getElementById('colorPickerPopover');
    const closePickerBtn = document.getElementById('closePickerBtn');
    const nativeColorInput = document.getElementById('nativeColorInput');
    const hexColorInput = document.getElementById('hexColorInput');
    const applyCustomColorBtn = document.getElementById('applyCustomColorBtn');

    const strokeSizeGroup = document.getElementById('strokeSizeGroup');
    const strokeSizeBtns = document.querySelectorAll('.stroke-size-btn');
    const undoBtn = document.getElementById('undoBtn');
    const resetAllBtn = document.getElementById('resetAllBtn');

    const rotateLeftBtn = document.getElementById('rotateLeftBtn');
    const rotateRightBtn = document.getElementById('rotateRightBtn');
    const gridBtn = document.getElementById('gridBtn');
    const shapeToggleBtn = document.getElementById('shapeToggleBtn');
    const resolutionSelect = document.getElementById('resolutionSelect');

    const viewport = document.getElementById('viewport');
    const emptyState = document.getElementById('emptyState');
    const canvasWrapper = document.getElementById('canvasWrapper');
    const canvas = document.getElementById('previewCanvas');
    const ctx = canvas.getContext('2d');
    const gridOverlay = document.getElementById('gridOverlay');
    const floatingTextInput = document.getElementById('floatingTextInput');
    const cropConfirmBar = document.getElementById('cropConfirmBar');
    const applyCropBtn = document.getElementById('applyCropBtn');
    const cancelCropBtn = document.getElementById('cancelCropBtn');

    const metaOverlay = document.getElementById('metaOverlay');
    const zoomOverlay = document.getElementById('zoomOverlay');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const toast = document.getElementById('toast');

    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const fitBtn = document.getElementById('fitBtn');
    const actualBtn = document.getElementById('actualBtn');

    const saveDirText = document.getElementById('saveDirText');
    const configureDirBtn = document.getElementById('configureDirBtn');
    const saveBtn = document.getElementById('saveBtn');
    const saveAsBtn = document.getElementById('saveAsBtn');
    const openTabBtn = document.getElementById('openTabBtn');

    // Settings Modal Elements
    const settingsModalBackdrop = document.getElementById('settingsModalBackdrop');
    const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
    const settingsLanguageSelect = document.getElementById('settingsLanguageSelect');
    const settingsSaveDirInput = document.getElementById('settingsSaveDirInput');
    const settingsBrowseDirBtn = document.getElementById('settingsBrowseDirBtn');
    const settingsAdbPathInput = document.getElementById('settingsAdbPathInput');
    const settingsStatusBarCheck = document.getElementById('settingsStatusBarCheck');
    const openIdeSettingsLink = document.getElementById('openIdeSettingsLink');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');

    let cachedDevices = [];
    let cachedOfflineEmulators = [];
    let cachedSelectedId = null;
    let cachedRunDeviceId = null;
    let cachedExtraRunTarget = null;
    let cachedLaunchState = {
      configs: [],
      selectedKey: '__default__',
      isDebugging: false,
      isFlutterOrDart: false,
      activeSessionName: '',
      runningDeviceIds: [],
    };

    let rawSourceImage = null;
    let workingImage = null;
    let rotationDegrees = 0;
    let scalePercent = 100;
    let shapeMode = 'rectangular';

    let activeTool = 'pan';
    let activeColor = '#ff3b30';
    let customColors = [];
    let strokeWidth = 6;
    let annotations = [];
    let historyStack = [];
    let currentDraftAnnotation = null;
    let pendingCropRect = null;
    let pendingTextPos = null;
    let annotationLayerCanvas = null;

    let viewZoom = 1;
    let panX = 0;
    let panY = 0;
    let isPointerDown = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let cursorCanvasPos = null;

    function applyTranslations() {
      document.getElementById('lblRunAndDebug').textContent = t('runAndDebugHeader');
      document.getElementById('lblConnectedDevices').textContent = t('connectedDevices');
      runDeviceSelect.title = t('selectRunDeviceTitle');
      document.getElementById('lblRefresh').textContent = t('refresh');
      openSettingsBtn.title = t('settings');
      runDebugBtn.title = t('runAndDebug');
      hotReloadBtn.title = t('hotReload');
      hotRestartBtn.title = t('hotRestart');
      stopDebugBtn.title = t('stopDebug');
      if (!cachedLaunchState.isDebugging) {
        launchConfigSelect.title = t('selectFlavorTitle');
      }
      if (!cachedLaunchState.configs || cachedLaunchState.configs.length === 0) {
        const defOpt = launchConfigSelect.querySelector('option[value="__default__"]');
        if (defOpt) defOpt.textContent = t('defaultLaunchConfig');
      }
      renderRunDeviceSpinner(cachedDevices, cachedOfflineEmulators, cachedRunDeviceId, cachedExtraRunTarget);
      recaptureBtn.title = t('recapture') + ' (R)';
      copyBtn.title = t('copyClipboard') + ' (Cmd+C)';
      document.getElementById('lblSendToPrompt').textContent = t('sendToPrompt');
      sendPromptBtn.title = t('sendToPrompt');

      document.getElementById('btnToolPan').title = t('toolMove');
      document.getElementById('btnToolPen').title = t('toolPen');
      document.getElementById('btnToolEraser').title = t('toolEraser');
      document.getElementById('btnToolHighlighter').title = t('toolHighlighter');
      document.getElementById('btnToolRect').title = t('toolRect');
      document.getElementById('btnToolCircle').title = t('toolCircle');
      document.getElementById('btnToolArrow').title = t('toolArrow');
      document.getElementById('btnToolText').title = t('toolText');
      document.getElementById('btnToolCrop').title = t('toolCrop');

      undoBtn.title = t('undo');
      resetAllBtn.textContent = t('resetOriginal');
      resetAllBtn.title = t('resetOriginalFull');

      document.getElementById('btnStrokeThin').title = t('strokeThin');
      document.getElementById('btnStrokeMedium').title = t('strokeMedium');
      document.getElementById('btnStrokeThick').title = t('strokeThick');

      document.getElementById('lblCustomColorTitle').textContent = t('customColorTitle');
      applyCustomColorBtn.textContent = t('apply');

      rotateLeftBtn.title = t('rotateLeft');
      rotateRightBtn.title = t('rotateRight');
      gridBtn.title = t('gridToggle');
      shapeToggleBtn.title = shapeMode === 'rounded' ? t('shapeRounded') : t('shapeRectangular');

      zoomInBtn.title = t('zoomIn');
      zoomOutBtn.title = t('zoomOut');
      fitBtn.title = t('fitToWindow');
      actualBtn.title = t('actualSize');

      document.getElementById('lblEmptyTitle').textContent = t('emptyTitle');
      document.getElementById('lblEmptyDesc').innerHTML = t('emptyDesc');
      floatingTextInput.placeholder = t('textPlaceholder');
      document.getElementById('lblCropSelected').textContent = t('cropSelected');
      applyCropBtn.textContent = t('applyCrop');
      cancelCropBtn.textContent = t('cancel');

      document.getElementById('lblSaveLocation').textContent = t('saveLocation');
      configureDirBtn.textContent = t('configure');
      const curSaveDir = saveDirText.textContent ? ' — ' + saveDirText.textContent : '';
      saveBtn.title = t('save') + ' (Cmd+S)' + curSaveDir;
      saveAsBtn.title = t('saveAs');
      openTabBtn.title = t('openLargeTab');

      document.getElementById('lblSettingsTitle').textContent = t('settingsTitle');
      document.getElementById('lblLanguage').textContent = t('languageLabel');
      document.getElementById('lblSaveDirSetting').textContent = t('saveDirLabel');
      settingsBrowseDirBtn.textContent = t('configure');
      document.getElementById('lblAdbPathSetting').textContent = t('adbPathLabel');
      settingsAdbPathInput.placeholder = t('adbPathPlaceholder');
      document.getElementById('lblStatusBarSetting').textContent = t('statusBarLabel');
      openIdeSettingsLink.textContent = t('ideSettingsLink');
      saveSettingsBtn.textContent = t('apply');

      renderDeviceList(cachedDevices, cachedSelectedId);
    }

    function showToast(text) {
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(showToast._timer);
      showToast._timer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2200);
    }

    // Settings Modal Handlers
    openSettingsBtn.addEventListener('click', () => {
      settingsLanguageSelect.value = currentLang;
      settingsSaveDirInput.value = saveDirText.textContent || '';
      settingsModalBackdrop.classList.add('visible');
    });

    closeSettingsModalBtn.addEventListener('click', () => {
      settingsModalBackdrop.classList.remove('visible');
    });

    settingsModalBackdrop.addEventListener('mousedown', (e) => {
      if (e.target === settingsModalBackdrop) {
        settingsModalBackdrop.classList.remove('visible');
      }
    });

    settingsLanguageSelect.addEventListener('change', () => {
      currentLang = settingsLanguageSelect.value;
      applyTranslations();
    });

    settingsBrowseDirBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'configureSaveDir' });
    });

    openIdeSettingsLink.addEventListener('click', () => {
      vscode.postMessage({ command: 'openIdeSettings' });
    });

    saveSettingsBtn.addEventListener('click', () => {
      currentLang = settingsLanguageSelect.value;
      applyTranslations();
      vscode.postMessage({
        command: 'updateSettings',
        language: currentLang,
        adbPath: settingsAdbPathInput.value,
        showStatusBar: settingsStatusBarCheck.checked,
      });
      settingsModalBackdrop.classList.remove('visible');
    });

    function selectColor(hex) {
      const normalized = hex.toLowerCase();
      activeColor = normalized;

      document.querySelectorAll('.color-dot').forEach((d) => {
        d.classList.toggle('active', (d.dataset.color || '').toLowerCase() === normalized);
      });

      if (floatingTextInput.style.display === 'block') {
        floatingTextInput.style.color = activeColor;
      }
    }

    function renderCustomColors() {
      customColorsContainer.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const hex = customColors[i];
        if (hex) {
          const dot = document.createElement('button');
          dot.className = 'color-dot custom-dot' + (hex.toLowerCase() === activeColor.toLowerCase() ? ' active' : '');
          dot.dataset.color = hex;
          dot.style.background = hex;
          dot.title = \`#\${i + 1} (\${hex.toUpperCase()})\`;
          dot.addEventListener('click', () => selectColor(hex));
          customColorsContainer.appendChild(dot);
        } else {
          const emptySlot = document.createElement('button');
          emptySlot.className = 'custom-slot-empty';
          emptySlot.title = \`#\${i + 1}\`;
          emptySlot.addEventListener('click', (e) => {
            e.stopPropagation();
            nativeColorInput.value = activeColor;
            hexColorInput.value = activeColor.toUpperCase();
            colorPickerPopover.classList.add('visible');
          });
          customColorsContainer.appendChild(emptySlot);
        }
      }
    }

    function addCustomColor(rawHex) {
      let cleaned = rawHex.trim();
      if (!cleaned.startsWith('#')) cleaned = '#' + cleaned;
      if (!/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
        showToast(t('toastInvalidHex'));
        return;
      }
      const lower = cleaned.toLowerCase();
      customColors = [lower, ...customColors.filter((c) => c.toLowerCase() !== lower)].slice(0, 3);
      vscode.postMessage({ command: 'saveCustomColors', colors: customColors });
      renderCustomColors();
      selectColor(lower);
      colorPickerPopover.classList.remove('visible');
    }

    presetDots.forEach((dot) => {
      dot.addEventListener('click', () => selectColor(dot.dataset.color));
    });

    colorPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      nativeColorInput.value = activeColor;
      hexColorInput.value = activeColor.toUpperCase();
      colorPickerPopover.classList.toggle('visible');
    });

    closePickerBtn.addEventListener('click', () => {
      colorPickerPopover.classList.remove('visible');
    });

    nativeColorInput.addEventListener('input', () => {
      hexColorInput.value = nativeColorInput.value.toUpperCase();
    });

    hexColorInput.addEventListener('input', () => {
      const val = hexColorInput.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        nativeColorInput.value = val.toLowerCase();
      }
    });

    hexColorInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustomColor(hexColorInput.value);
      } else if (e.key === 'Escape') {
        colorPickerPopover.classList.remove('visible');
      }
    });

    applyCustomColorBtn.addEventListener('click', () => {
      addCustomColor(hexColorInput.value);
    });

    window.addEventListener('mousedown', (e) => {
      if (
        colorPickerPopover.classList.contains('visible') &&
        !colorPickerPopover.contains(e.target) &&
        !colorPickerBtn.contains(e.target)
      ) {
        colorPickerPopover.classList.remove('visible');
      }
    });

    function setControlsEnabled(enabled) {
      recaptureBtn.disabled = !enabled && !cachedSelectedId;
      copyBtn.disabled = !enabled;
      sendPromptBtn.disabled = !enabled;
      rotateLeftBtn.disabled = !enabled;
      rotateRightBtn.disabled = !enabled;
      gridBtn.disabled = !enabled;
      shapeToggleBtn.disabled = !enabled;
      resolutionSelect.disabled = !enabled;
      saveBtn.disabled = !enabled;
      saveAsBtn.disabled = !enabled;
      openTabBtn.disabled = !enabled;

      if (enabled) {
        emptyState.style.display = 'none';
        canvasWrapper.classList.add('visible');
        metaOverlay.classList.add('visible');
        zoomOverlay.classList.add('visible');
      } else {
        emptyState.style.display = 'flex';
        canvasWrapper.classList.remove('visible');
        metaOverlay.classList.remove('visible');
        zoomOverlay.classList.remove('visible');
      }
      updateHistoryButtons();
    }

    function pushHistorySnapshot() {
      if (!workingImage) return;
      historyStack.push({
        workingImageSrc: workingImage.src,
        rotationDegrees,
        annotations: JSON.parse(JSON.stringify(annotations)),
      });
      if (historyStack.length > 30) {
        historyStack.shift();
      }
      updateHistoryButtons();
    }

    function updateHistoryButtons() {
      const hasImage = !!rawSourceImage;
      const isModified =
        historyStack.length > 0 ||
        annotations.length > 0 ||
        rotationDegrees !== 0 ||
        (workingImage && rawSourceImage && workingImage.src !== rawSourceImage.src);
      undoBtn.disabled = !hasImage || historyStack.length === 0;
      resetAllBtn.disabled = !hasImage || !isModified;
    }

    function setActiveTool(tool) {
      commitFloatingText();
      pendingCropRect = null;
      cropConfirmBar.classList.remove('visible');
      activeTool = tool;

      toolBtns.forEach((b) => {
        b.classList.toggle('active', b.dataset.tool === tool);
      });

      strokeSizeGroup.classList.toggle('eraser-mode', tool === 'eraser');

      viewport.classList.remove('mode-pan', 'mode-draw', 'mode-text');
      if (tool === 'pan') {
        viewport.classList.add('mode-pan');
      } else if (tool === 'text') {
        viewport.classList.add('mode-text');
      } else {
        viewport.classList.add('mode-draw');
      }
      renderCanvas(false);
    }

    toolBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        setActiveTool(btn.dataset.tool);
      });
    });

    strokeSizeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        strokeWidth = parseInt(btn.dataset.size, 10) || 6;
        strokeSizeBtns.forEach((b) => b.classList.toggle('active', b === btn));
        if (activeTool === 'eraser') renderCanvas(false);
      });
    });

    undoBtn.addEventListener('click', () => {
      if (historyStack.length === 0) return;
      const prev = historyStack.pop();
      rotationDegrees = prev.rotationDegrees;
      annotations = prev.annotations;
      pendingCropRect = null;
      cropConfirmBar.classList.remove('visible');

      const img = new Image();
      img.onload = () => {
        workingImage = img;
        renderCanvas(true);
        updateHistoryButtons();
      };
      img.src = prev.workingImageSrc;
    });

    resetAllBtn.addEventListener('click', () => {
      if (!rawSourceImage) return;
      commitFloatingText();
      workingImage = rawSourceImage;
      rotationDegrees = 0;
      annotations = [];
      historyStack = [];
      pendingCropRect = null;
      cropConfirmBar.classList.remove('visible');
      renderCanvas(true);
      updateHistoryButtons();
      showToast(t('toastReset'));
    });

    function renderRunDeviceSpinner(devices, offlineEmulators, runDeviceId, extraTarget) {
      cachedOfflineEmulators = offlineEmulators || [];
      cachedRunDeviceId = runDeviceId || null;
      cachedExtraRunTarget = extraTarget || null;
      runDeviceSelect.innerHTML = '';

      const list = devices || [];
      const offlineList = cachedOfflineEmulators;
      let hasAnyTarget = false;

      if (list.length > 0 || (extraTarget && extraTarget.id)) {
        const availGroup = document.createElement('optgroup');
        availGroup.label = t('availableDevicesGroup');

        list.forEach((d) => {
          hasAnyTarget = true;
          const opt = document.createElement('option');
          opt.value = d.id;
          const platformLabel = d.platform === 'android' ? 'Android' : 'iOS';
          const transportLabel =
            d.reality === 'physical'
              ? d.transport === 'wifi'
                ? t('wifiBadge')
                : t('usbBadge')
              : d.platform === 'android'
              ? 'Emulator'
              : 'Simulator';
          const isRunningOnThis =
            Array.isArray(cachedLaunchState.runningDeviceIds) &&
            cachedLaunchState.runningDeviceIds.some((rid) => String(rid).toLowerCase() === String(d.id).toLowerCase());
          opt.textContent = \`\${isRunningOnThis ? '● ' : ''}\${d.name} · \${platformLabel} (\${transportLabel})\`;
          if (d.id === cachedRunDeviceId) {
            opt.selected = true;
          }
          availGroup.appendChild(opt);
        });

        if (extraTarget && extraTarget.id && !list.some((d) => d.id === extraTarget.id)) {
          hasAnyTarget = true;
          const opt = document.createElement('option');
          opt.value = extraTarget.id;
          opt.textContent = extraTarget.label || extraTarget.id;
          if (extraTarget.id === cachedRunDeviceId) {
            opt.selected = true;
          }
          availGroup.appendChild(opt);
        }

        runDeviceSelect.appendChild(availGroup);
      }

      if (offlineList.length > 0) {
        const offlineGroup = document.createElement('optgroup');
        offlineGroup.label = t('offlineEmulatorsGroup');

        offlineList.forEach((em) => {
          hasAnyTarget = true;
          const opt = document.createElement('option');
          opt.value = em.id;
          const coldSuffix = em.coldBoot ? ' (cold boot)' : '';
          opt.textContent = \`▷ Start \${em.name}\${coldSuffix}\`;
          if (em.id === cachedRunDeviceId) {
            opt.selected = true;
          }
          offlineGroup.appendChild(opt);
        });

        runDeviceSelect.appendChild(offlineGroup);
      }

      if (!hasAnyTarget) {
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '__none__';
        emptyOpt.textContent = t('noRunDevice');
        emptyOpt.selected = true;
        runDeviceSelect.appendChild(emptyOpt);
      }

      const moreOpt = document.createElement('option');
      moreOpt.value = '__open_picker__';
      moreOpt.textContent = t('moreDevicesOrEmulator');
      runDeviceSelect.appendChild(moreOpt);
    }

    function renderDeviceList(devices, selectedId) {
      cachedDevices = devices || [];
      cachedSelectedId = selectedId;
      recaptureBtn.disabled = !rawSourceImage && !cachedSelectedId;
      deviceListEl.innerHTML = '';
      if (!devices || devices.length === 0) {
        deviceListEl.innerHTML = \`<div class="empty-devices">\${t('noDevicesFound')}</div>\`;
        return;
      }

      devices.forEach((d) => {
        const item = document.createElement('div');
        item.className = 'device-item' + (d.id === selectedId ? ' selected' : '');

        const isPhysical = d.reality === 'physical';
        const isWifi = d.transport === 'wifi';
        const svgIcon = isPhysical ? SVG_PHONE : SVG_SIM;
        const platformLabel = d.platform === 'android' ? 'Android' : 'iOS';
        const transportLabel = isPhysical
          ? isWifi
            ? t('wifiBadge')
            : t('usbBadge')
          : d.platform === 'android'
          ? 'Emulator'
          : 'Simulator';

        let badgeClass = 'badge badge-sim';
        let badgeText = t('simulatorBadge');
        if (isPhysical) {
          if (isWifi) {
            badgeClass = 'badge badge-wifi';
            badgeText = t('wifiBadge');
          } else {
            badgeClass = 'badge badge-usb';
            badgeText = t('usbBadge');
          }
        }

        item.innerHTML = \`
          <div class="device-info">
            <span class="device-icon">\${svgIcon}</span>
            <div class="device-text">
              <span class="device-name">\${d.name}</span>
              <span class="device-sub">\${platformLabel} · \${transportLabel} · \${d.id}</span>
            </div>
          </div>
          <span class="\${badgeClass}">\${badgeText}</span>
        \`;

        item.addEventListener('click', () => {
          cachedSelectedId = d.id;
          vscode.postMessage({ command: 'selectDevice', deviceId: d.id });
          document.querySelectorAll('.device-item').forEach((el) => el.classList.remove('selected'));
          item.classList.add('selected');
        });

        deviceListEl.appendChild(item);
      });
    }

    function syncRunPlayButtonVisibility() {
      const isDebugging = !!cachedLaunchState.isDebugging;
      runBar.classList.toggle('running', isDebugging);
      if (!isDebugging) {
        runBar.classList.remove('can-launch-another');
        return;
      }
      const runningIds = Array.isArray(cachedLaunchState.runningDeviceIds)
        ? cachedLaunchState.runningDeviceIds.map((r) => String(r).toLowerCase())
        : [];
      const curTarget = String(cachedRunDeviceId || '').toLowerCase();
      const canLaunchAnother =
        runningIds.length > 0 &&
        curTarget &&
        curTarget !== '__none__' &&
        !runningIds.includes(curTarget);
      runBar.classList.toggle('can-launch-another', !!canLaunchAnother);
    }

    function renderLaunchState(state) {
      if (!state) return;
      const prevRunningKey = (cachedLaunchState.runningDeviceIds || []).join(',');
      cachedLaunchState = state;

      launchConfigSelect.innerHTML = '';
      if (!state.configs || state.configs.length === 0) {
        const opt = document.createElement('option');
        opt.value = '__default__';
        opt.textContent = t('defaultLaunchConfig');
        launchConfigSelect.appendChild(opt);
        launchConfigSelect.value = '__default__';
      } else {
        state.configs.forEach((cfg) => {
          const opt = document.createElement('option');
          opt.value = cfg.key;
          opt.textContent = cfg.label;
          if (cfg.key === state.selectedKey) {
            opt.selected = true;
          }
          launchConfigSelect.appendChild(opt);
        });
      }

      launchConfigSelect.title =
        state.isDebugging && state.activeSessionName
          ? \`● \${state.activeSessionName}\`
          : t('selectFlavorTitle');

      const nextRunningKey = (state.runningDeviceIds || []).join(',');
      if (prevRunningKey !== nextRunningKey) {
        renderRunDeviceSpinner(cachedDevices, cachedOfflineEmulators, cachedRunDeviceId, cachedExtraRunTarget);
      }
      syncRunPlayButtonVisibility();
    }

    function drawSingleAnnotation(context, ann) {
      context.save();
      context.strokeStyle = ann.color;
      context.fillStyle = ann.color;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      const dpiScale = Math.max(1, Math.min(canvas.width, canvas.height) / 500);
      const lineW = ann.size * dpiScale;
      context.lineWidth = lineW;

      if (ann.type === 'pen' || ann.type === 'highlighter' || ann.type === 'eraser') {
        if (ann.type === 'eraser') {
          context.globalCompositeOperation = 'destination-out';
          context.strokeStyle = 'rgba(0,0,0,1)';
          context.fillStyle = 'rgba(0,0,0,1)';
          context.lineWidth = lineW * 3.8;
        } else if (ann.type === 'highlighter') {
          context.globalAlpha = 0.38;
          context.lineWidth = lineW * 2.8;
        }
        const pts = ann.points || [];
        if (pts.length === 1) {
          context.beginPath();
          context.arc(pts[0].x, pts[0].y, context.lineWidth / 2, 0, Math.PI * 2);
          context.fill();
        } else if (pts.length > 1) {
          context.beginPath();
          context.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            context.lineTo(pts[i].x, pts[i].y);
          }
          context.stroke();
        }
      } else if (ann.type === 'rect') {
        const x = Math.min(ann.x1, ann.x2);
        const y = Math.min(ann.y1, ann.y2);
        const w = Math.abs(ann.x2 - ann.x1);
        const h = Math.abs(ann.y2 - ann.y1);
        context.strokeRect(x, y, w, h);
      } else if (ann.type === 'circle') {
        const cx = (ann.x1 + ann.x2) / 2;
        const cy = (ann.y1 + ann.y2) / 2;
        const rx = Math.abs(ann.x2 - ann.x1) / 2;
        const ry = Math.abs(ann.y2 - ann.y1) / 2;
        context.beginPath();
        context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        context.stroke();
      } else if (ann.type === 'arrow') {
        const headLen = Math.max(16 * dpiScale, lineW * 3.2);
        const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
        context.beginPath();
        context.moveTo(ann.x1, ann.y1);
        context.lineTo(ann.x2, ann.y2);
        context.stroke();

        context.beginPath();
        context.moveTo(ann.x2, ann.y2);
        context.lineTo(
          ann.x2 - headLen * Math.cos(angle - Math.PI / 6),
          ann.y2 - headLen * Math.sin(angle - Math.PI / 6)
        );
        context.lineTo(
          ann.x2 - headLen * Math.cos(angle + Math.PI / 6),
          ann.y2 - headLen * Math.sin(angle + Math.PI / 6)
        );
        context.closePath();
        context.fill();
      } else if (ann.type === 'text' && ann.text) {
        const fontSize = Math.round((ann.size * 3.2 + 12) * dpiScale);
        context.font = \`700 \${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif\`;
        context.textBaseline = 'top';
        context.lineWidth = Math.max(3, fontSize * 0.14);
        context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        context.strokeText(ann.text, ann.x, ann.y);
        context.fillStyle = ann.color;
        context.fillText(ann.text, ann.x, ann.y);
      }
      context.restore();
    }

    function renderCanvas(fitAfterRender = false, includeCropOverlay = true) {
      if (!workingImage) return;

      const isRotated90 = rotationDegrees % 180 !== 0;
      const rawW = isRotated90 ? workingImage.naturalHeight : workingImage.naturalWidth;
      const rawH = isRotated90 ? workingImage.naturalWidth : workingImage.naturalHeight;

      const targetW = Math.max(1, Math.round((rawW * scalePercent) / 100));
      const targetH = Math.max(1, Math.round((rawH * scalePercent) / 100));

      canvas.width = targetW;
      canvas.height = targetH;

      ctx.save();
      ctx.clearRect(0, 0, targetW, targetH);

      if (shapeMode === 'rounded') {
        const radius = Math.round(Math.min(targetW, targetH) * 0.085);
        ctx.beginPath();
        ctx.roundRect(0, 0, targetW, targetH, radius);
        ctx.clip();
      }

      ctx.save();
      ctx.translate(targetW / 2, targetH / 2);
      ctx.rotate((rotationDegrees * Math.PI) / 180);
      const drawW = isRotated90 ? targetH : targetW;
      const drawH = isRotated90 ? targetW : targetH;
      ctx.drawImage(workingImage, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();

      if (annotations.length > 0 || currentDraftAnnotation) {
        if (!annotationLayerCanvas) {
          annotationLayerCanvas = document.createElement('canvas');
        }
        annotationLayerCanvas.width = targetW;
        annotationLayerCanvas.height = targetH;
        const annCtx = annotationLayerCanvas.getContext('2d');
        annCtx.clearRect(0, 0, targetW, targetH);

        for (const ann of annotations) {
          drawSingleAnnotation(annCtx, ann);
        }
        if (currentDraftAnnotation) {
          drawSingleAnnotation(annCtx, currentDraftAnnotation);
        }
        ctx.drawImage(annotationLayerCanvas, 0, 0);
      }

      if (includeCropOverlay && activeTool === 'eraser' && cursorCanvasPos) {
        const dpiScale = Math.max(1, Math.min(targetW, targetH) / 500);
        const eraserRadius = (strokeWidth * dpiScale * 3.8) / 2;
        const borderScale = Math.max(1, 1 / Math.max(0.15, viewZoom));
        ctx.save();
        // High-contrast semi-transparent red tint inside the eraser circle
        ctx.beginPath();
        ctx.arc(cursorCanvasPos.x, cursorCanvasPos.y, eraserRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 59, 48, 0.22)';
        ctx.fill();
        // Outer dark ring (visible on white/light backgrounds)
        ctx.lineWidth = 2.8 * borderScale;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.88)';
        ctx.stroke();
        // Inner bright white ring (visible on dark backgrounds)
        ctx.beginPath();
        ctx.arc(cursorCanvasPos.x, cursorCanvasPos.y, eraserRadius, 0, Math.PI * 2);
        ctx.lineWidth = 1.4 * borderScale;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        // Center crosshair dot
        ctx.beginPath();
        ctx.arc(cursorCanvasPos.x, cursorCanvasPos.y, 2 * borderScale, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3b30';
        ctx.fill();
        ctx.restore();
      }

      if (includeCropOverlay && pendingCropRect && pendingCropRect.w > 4 && pendingCropRect.h > 4) {
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, targetW, pendingCropRect.y);
        ctx.fillRect(0, pendingCropRect.y + pendingCropRect.h, targetW, targetH - (pendingCropRect.y + pendingCropRect.h));
        ctx.fillRect(0, pendingCropRect.y, pendingCropRect.x, pendingCropRect.h);
        ctx.fillRect(
          pendingCropRect.x + pendingCropRect.w,
          pendingCropRect.y,
          targetW - (pendingCropRect.x + pendingCropRect.w),
          pendingCropRect.h
        );

        ctx.strokeStyle = '#3574f0';
        ctx.lineWidth = Math.max(2, targetW / 300);
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(pendingCropRect.x, pendingCropRect.y, pendingCropRect.w, pendingCropRect.h);
        ctx.restore();
      }

      ctx.restore();

      const dataUrl = canvas.toDataURL('image/png');
      const base64Length = dataUrl.length - 'data:image/png;base64,'.length;
      const kbSize = (Math.round((base64Length * 3) / 4) / 1024).toFixed(1);
      metaOverlay.textContent = \`\${targetW.toLocaleString()}×\${targetH.toLocaleString()} · \${kbSize} kB\`;

      if (fitAfterRender) {
        fitToViewport();
      } else {
        applyTransform();
      }
      updateHistoryButtons();
    }

    function getCleanExportDataUrl() {
      renderCanvas(false, false);
      const url = canvas.toDataURL('image/png');
      if (pendingCropRect || activeTool === 'eraser') {
        renderCanvas(false, true);
      }
      return url;
    }

    function fitToViewport() {
      if (!canvas.width || !canvas.height) return;
      const pad = 20;
      const vw = Math.max(80, viewport.clientWidth - pad);
      const vh = Math.max(80, viewport.clientHeight - pad);
      viewZoom = Math.min(vw / canvas.width, vh / canvas.height, 1);
      panX = 0;
      panY = 0;
      applyTransform();
    }

    function applyTransform() {
      canvas.style.width = Math.round(canvas.width * viewZoom) + 'px';
      canvas.style.height = Math.round(canvas.height * viewZoom) + 'px';
      canvasWrapper.style.transform = \`translate(\${panX}px, \${panY}px)\`;
    }

    function clientToCanvasCoords(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: Math.max(0, Math.min(canvas.width, (clientX - rect.left) * scaleX)),
        y: Math.max(0, Math.min(canvas.height, (clientY - rect.top) * scaleY)),
      };
    }

    function commitFloatingText() {
      if (floatingTextInput.style.display !== 'block') return;
      const val = floatingTextInput.value.trim();
      if (val && pendingTextPos) {
        pushHistorySnapshot();
        annotations.push({
          type: 'text',
          color: activeColor,
          size: strokeWidth,
          x: pendingTextPos.x,
          y: pendingTextPos.y,
          text: val,
        });
        renderCanvas(false);
      }
      floatingTextInput.value = '';
      floatingTextInput.style.display = 'none';
      pendingTextPos = null;
    }

    floatingTextInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitFloatingText();
      } else if (e.key === 'Escape') {
        floatingTextInput.value = '';
        floatingTextInput.style.display = 'none';
        pendingTextPos = null;
      }
    });

    applyCropBtn.addEventListener('click', () => {
      if (!pendingCropRect || pendingCropRect.w < 10 || pendingCropRect.h < 10) return;
      const crop = { ...pendingCropRect };
      pendingCropRect = null;
      cropConfirmBar.classList.remove('visible');

      renderCanvas(false, false);
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.round(crop.w);
      offscreen.height = Math.round(crop.h);
      const offCtx = offscreen.getContext('2d');
      offCtx.drawImage(
        canvas,
        Math.round(crop.x),
        Math.round(crop.y),
        Math.round(crop.w),
        Math.round(crop.h),
        0,
        0,
        Math.round(crop.w),
        Math.round(crop.h)
      );

      pushHistorySnapshot();
      const croppedDataUrl = offscreen.toDataURL('image/png');
      const newImg = new Image();
      newImg.onload = () => {
        workingImage = newImg;
        rotationDegrees = 0;
        annotations = [];
        setActiveTool('pan');
        renderCanvas(true);
        showToast(t('toastCropped'));
      };
      newImg.src = croppedDataUrl;
    });

    cancelCropBtn.addEventListener('click', () => {
      pendingCropRect = null;
      cropConfirmBar.classList.remove('visible');
      renderCanvas(false);
    });

    viewport.addEventListener('mousedown', (e) => {
      if (!workingImage || e.button !== 0) return;
      if (e.target === floatingTextInput || cropConfirmBar.contains(e.target) || zoomOverlay.contains(e.target)) {
        return;
      }

      if (activeTool === 'text') {
        commitFloatingText();
        const pt = clientToCanvasCoords(e.clientX, e.clientY);
        pendingTextPos = pt;
        const vpRect = viewport.getBoundingClientRect();
        floatingTextInput.style.left = Math.min(vpRect.width - 110, Math.max(8, e.clientX - vpRect.left)) + 'px';
        floatingTextInput.style.top = Math.min(vpRect.height - 36, Math.max(8, e.clientY - vpRect.top)) + 'px';
        floatingTextInput.style.color = activeColor;
        floatingTextInput.style.display = 'block';
        setTimeout(() => floatingTextInput.focus(), 10);
        return;
      }

      isPointerDown = true;

      if (activeTool === 'pan') {
        dragStartX = e.clientX - panX;
        dragStartY = e.clientY - panY;
        viewport.classList.add('dragging');
        return;
      }

      const pt = clientToCanvasCoords(e.clientX, e.clientY);
      dragStartX = pt.x;
      dragStartY = pt.y;

      if (activeTool === 'crop') {
        cropConfirmBar.classList.remove('visible');
        pendingCropRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
      } else if (activeTool === 'pen' || activeTool === 'highlighter' || activeTool === 'eraser') {
        currentDraftAnnotation = {
          type: activeTool,
          color: activeColor,
          size: strokeWidth,
          points: [{ x: pt.x, y: pt.y }],
        };
        if (activeTool === 'eraser') {
          cursorCanvasPos = pt;
          renderCanvas(false, true);
        }
      } else if (activeTool === 'rect' || activeTool === 'circle' || activeTool === 'arrow') {
        currentDraftAnnotation = {
          type: activeTool,
          color: activeColor,
          size: strokeWidth,
          x1: pt.x,
          y1: pt.y,
          x2: pt.x,
          y2: pt.y,
        };
      }
    });

    viewport.addEventListener('mouseleave', () => {
      if (cursorCanvasPos) {
        cursorCanvasPos = null;
        if (activeTool === 'eraser' && workingImage) {
          renderCanvas(false, true);
        }
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (workingImage && activeTool === 'eraser') {
        const vpRect = viewport.getBoundingClientRect();
        if (
          e.clientX >= vpRect.left &&
          e.clientX <= vpRect.right &&
          e.clientY >= vpRect.top &&
          e.clientY <= vpRect.bottom
        ) {
          cursorCanvasPos = clientToCanvasCoords(e.clientX, e.clientY);
          if (!isPointerDown) {
            renderCanvas(false, true);
          }
        } else if (cursorCanvasPos) {
          cursorCanvasPos = null;
          if (!isPointerDown) {
            renderCanvas(false, true);
          }
        }
      }

      if (!isPointerDown || !workingImage) return;

      if (activeTool === 'pan') {
        panX = e.clientX - dragStartX;
        panY = e.clientY - dragStartY;
        applyTransform();
        return;
      }

      const pt = clientToCanvasCoords(e.clientX, e.clientY);

      if (activeTool === 'crop') {
        pendingCropRect = {
          x: Math.min(dragStartX, pt.x),
          y: Math.min(dragStartY, pt.y),
          w: Math.abs(pt.x - dragStartX),
          h: Math.abs(pt.y - dragStartY),
        };
        renderCanvas(false, true);
      } else if (currentDraftAnnotation) {
        if (activeTool === 'pen' || activeTool === 'highlighter' || activeTool === 'eraser') {
          currentDraftAnnotation.points.push({ x: pt.x, y: pt.y });
        } else {
          currentDraftAnnotation.x2 = pt.x;
          currentDraftAnnotation.y2 = pt.y;
        }
        renderCanvas(false, activeTool === 'eraser');
      }
    });

    window.addEventListener('mouseup', () => {
      if (!isPointerDown) return;
      isPointerDown = false;
      viewport.classList.remove('dragging');

      if (activeTool === 'crop') {
        if (pendingCropRect && pendingCropRect.w > 12 && pendingCropRect.h > 12) {
          cropConfirmBar.classList.add('visible');
        } else {
          pendingCropRect = null;
          cropConfirmBar.classList.remove('visible');
          renderCanvas(false);
        }
      } else if (currentDraftAnnotation) {
        pushHistorySnapshot();
        annotations.push(currentDraftAnnotation);
        currentDraftAnnotation = null;
        renderCanvas(false);
      }
    });

    zoomOverlay.addEventListener('mousedown', (e) => e.stopPropagation());
    zoomOverlay.addEventListener('click', (e) => e.stopPropagation());

    runDeviceSelect.addEventListener('change', () => {
      if (runDeviceSelect.value === '__open_picker__') {
        renderRunDeviceSpinner(cachedDevices, cachedOfflineEmulators, cachedRunDeviceId, cachedExtraRunTarget);
        vscode.postMessage({ command: 'selectIdeDevice' });
        return;
      }
      if (runDeviceSelect.value && runDeviceSelect.value !== '__none__') {
        cachedRunDeviceId = runDeviceSelect.value;
        syncRunPlayButtonVisibility();
        vscode.postMessage({ command: 'selectRunDevice', deviceId: cachedRunDeviceId });
      }
    });

    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshDevices' });
    });

    launchConfigSelect.addEventListener('change', () => {
      vscode.postMessage({ command: 'selectLaunchConfig', key: launchConfigSelect.value });
    });

    runDebugBtn.addEventListener('click', () => {
      vscode.postMessage({
        command: 'runLaunch',
        key: launchConfigSelect.value,
        runDeviceId: runDeviceSelect.value,
        noDebug: false,
      });
    });

    hotReloadBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'hotReload' });
    });

    hotRestartBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'hotRestart' });
    });

    stopDebugBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'stopDebug' });
    });

    recaptureBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'recapture' });
    });

    copyBtn.addEventListener('click', () => {
      if (!workingImage) return;
      commitFloatingText();
      vscode.postMessage({ command: 'copyToClipboard', dataUrl: getCleanExportDataUrl() });
    });

    sendPromptBtn.addEventListener('click', () => {
      if (!workingImage) return;
      commitFloatingText();
      vscode.postMessage({ command: 'sendToPrompt', dataUrl: getCleanExportDataUrl() });
    });

    rotateLeftBtn.addEventListener('click', () => {
      pushHistorySnapshot();
      rotationDegrees = (rotationDegrees + 270) % 360;
      renderCanvas(true);
    });

    rotateRightBtn.addEventListener('click', () => {
      pushHistorySnapshot();
      rotationDegrees = (rotationDegrees + 90) % 360;
      renderCanvas(true);
    });

    gridBtn.addEventListener('click', () => {
      const active = gridOverlay.classList.toggle('visible');
      gridBtn.classList.toggle('active', active);
    });

    shapeToggleBtn.addEventListener('click', () => {
      shapeMode = shapeMode === 'rectangular' ? 'rounded' : 'rectangular';
      shapeToggleBtn.classList.toggle('active', shapeMode === 'rounded');
      shapeToggleBtn.title = shapeMode === 'rounded' ? t('shapeRounded') : t('shapeRectangular');
      renderCanvas(false);
    });

    resolutionSelect.addEventListener('change', () => {
      scalePercent = parseInt(resolutionSelect.value, 10) || 100;
      renderCanvas(true);
    });

    zoomInBtn.addEventListener('click', () => {
      viewZoom = Math.min(6, viewZoom * 1.25);
      applyTransform();
    });

    zoomOutBtn.addEventListener('click', () => {
      viewZoom = Math.max(0.1, viewZoom / 1.25);
      applyTransform();
    });

    fitBtn.addEventListener('click', () => fitToViewport());

    actualBtn.addEventListener('click', () => {
      viewZoom = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    });

    saveBtn.addEventListener('click', () => {
      if (!workingImage) return;
      commitFloatingText();
      vscode.postMessage({ command: 'saveImage', dataUrl: getCleanExportDataUrl() });
    });

    saveAsBtn.addEventListener('click', () => {
      if (!workingImage) return;
      commitFloatingText();
      vscode.postMessage({ command: 'saveImageAs', dataUrl: getCleanExportDataUrl() });
    });

    openTabBtn.addEventListener('click', () => {
      if (!workingImage) return;
      commitFloatingText();
      vscode.postMessage({ command: 'openInLargeTab', dataUrl: getCleanExportDataUrl() });
    });

    configureDirBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'configureSaveDir' });
    });

    viewport.addEventListener(
      'wheel',
      (e) => {
        if (!workingImage) return;
        e.preventDefault();
        viewZoom = Math.min(6, Math.max(0.1, viewZoom * (e.deltaY < 0 ? 1.12 : 0.89)));
        applyTransform();
      },
      { passive: false }
    );

    window.addEventListener('resize', () => {
      if (workingImage) fitToViewport();
    });

    window.addEventListener('keydown', (e) => {
      if (
        document.activeElement === floatingTextInput ||
        document.activeElement === hexColorInput ||
        document.activeElement === settingsAdbPathInput ||
        (document.activeElement && document.activeElement.tagName === 'SELECT')
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoBtn.click();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copyBtn.click();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveBtn.click();
      } else if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) {
        recaptureBtn.click();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.command) {
        case 'scanningDevices':
          deviceListEl.innerHTML = \`<div class="empty-devices">\${t('scanningDevices')}</div>\`;
          break;

        case 'launchStateUpdated':
          if (msg.offlineEmulators !== undefined) {
            cachedOfflineEmulators = msg.offlineEmulators;
          }
          if (msg.runDeviceId !== undefined) {
            cachedRunDeviceId = msg.runDeviceId;
          }
          if (msg.extraRunTarget !== undefined) {
            cachedExtraRunTarget = msg.extraRunTarget;
          }
          renderLaunchState(msg.state);
          renderRunDeviceSpinner(cachedDevices, cachedOfflineEmulators, cachedRunDeviceId, cachedExtraRunTarget);
          break;

        case 'settingsUpdated':
          if (msg.language) {
            currentLang = msg.language;
            settingsLanguageSelect.value = currentLang;
          }
          if (msg.saveDir) {
            saveDirText.textContent = msg.saveDir;
            settingsSaveDirInput.value = msg.saveDir;
          }
          if (typeof msg.adbPath === 'string') {
            settingsAdbPathInput.value = msg.adbPath;
          }
          if (typeof msg.showStatusBar === 'boolean') {
            settingsStatusBarCheck.checked = msg.showStatusBar;
          }
          applyTranslations();
          break;

        case 'openSettingsModal':
          settingsLanguageSelect.value = currentLang;
          settingsSaveDirInput.value = saveDirText.textContent || '';
          settingsModalBackdrop.classList.add('visible');
          break;

        case 'devicesUpdated':
          if (msg.language) {
            currentLang = msg.language;
            settingsLanguageSelect.value = currentLang;
          }
          if (msg.saveDir) {
            saveDirText.textContent = msg.saveDir;
            settingsSaveDirInput.value = msg.saveDir;
          }
          if (typeof msg.adbPath === 'string') {
            settingsAdbPathInput.value = msg.adbPath;
          }
          if (typeof msg.showStatusBar === 'boolean') {
            settingsStatusBarCheck.checked = msg.showStatusBar;
          }
          if (Array.isArray(msg.customColors)) {
            customColors = msg.customColors.slice(0, 3);
            renderCustomColors();
          }
          if (msg.offlineEmulators !== undefined) {
            cachedOfflineEmulators = msg.offlineEmulators;
          }
          if (msg.runDeviceId !== undefined) {
            cachedRunDeviceId = msg.runDeviceId;
          }
          if (msg.extraRunTarget !== undefined) {
            cachedExtraRunTarget = msg.extraRunTarget;
          }
          if (msg.launchState) {
            renderLaunchState(msg.launchState);
          }
          renderDeviceList(msg.devices, msg.selectedDeviceId);
          renderRunDeviceSpinner(cachedDevices, cachedOfflineEmulators, cachedRunDeviceId, cachedExtraRunTarget);
          applyTranslations();
          break;

        case 'capturing':
          loadingText.textContent = \`\${msg.device?.name || ''} \${t('capturingDevice')}\`;
          loadingOverlay.classList.add('visible');
          break;

        case 'captured':
          loadingOverlay.classList.remove('visible');
          if (msg.saveDir) saveDirText.textContent = msg.saveDir;
          const img = new Image();
          img.onload = () => {
            rawSourceImage = img;
            workingImage = img;
            rotationDegrees = 0;
            annotations = [];
            historyStack = [];
            pendingCropRect = null;
            cropConfirmBar.classList.remove('visible');
            setControlsEnabled(true);
            renderCanvas(true);
          };
          img.src = 'data:image/png;base64,' + msg.base64;
          break;

        case 'captureError':
          loadingOverlay.classList.remove('visible');
          showToast(t('toastCaptureFailed') + msg.error);
          break;

        case 'saveDirUpdated':
          saveDirText.textContent = msg.saveDir;
          settingsSaveDirInput.value = msg.saveDir;
          showToast(t('toastSaveDirUpdated'));
          break;

        case 'toast':
          showToast(msg.text);
          break;
      }
    });

    applyTranslations();
    renderCustomColors();
    setControlsEnabled(false);
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
