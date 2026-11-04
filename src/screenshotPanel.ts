import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DeviceManager, MobileDevice } from './deviceManager';
import { normalizeLanguage, SupportedLanguage, TRANSLATIONS } from './i18n';

export class ScreenshotPanel {
  public static currentPanel: ScreenshotPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private readonly _deviceManager: DeviceManager;
  private _disposables: vscode.Disposable[] = [];
  private _currentDevice: MobileDevice;
  private _devices: MobileDevice[] = [];

  public static async createOrShow(
    context: vscode.ExtensionContext,
    deviceManager: DeviceManager,
    device: MobileDevice,
    devices: MobileDevice[],
    initialDataUrl?: string
  ) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (ScreenshotPanel.currentPanel) {
      ScreenshotPanel.currentPanel._currentDevice = device;
      ScreenshotPanel.currentPanel._devices = devices;
      ScreenshotPanel.currentPanel._panel.reveal(column);
      if (initialDataUrl) {
        ScreenshotPanel.currentPanel.sendExistingDataUrl(initialDataUrl);
      } else {
        await ScreenshotPanel.currentPanel.captureAndSend();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mobileDeviceScreenshot',
      `Screenshot of ${device.name}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ScreenshotPanel.currentPanel = new ScreenshotPanel(panel, context, deviceManager, device, devices);
    if (initialDataUrl) {
      ScreenshotPanel.currentPanel.sendExistingDataUrl(initialDataUrl);
    } else {
      await ScreenshotPanel.currentPanel.captureAndSend();
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    deviceManager: DeviceManager,
    device: MobileDevice,
    devices: MobileDevice[]
  ) {
    this._panel = panel;
    this._context = context;
    this._deviceManager = deviceManager;
    this._currentDevice = device;
    this._devices = devices;

    this._panel.webview.html = this._getHtmlForWebview();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    const watchDisposable = this._deviceManager.startWatching();
    this._disposables.push(watchDisposable);

    this._disposables.push(
      this._deviceManager.onDidChangeDevices((devices) => {
        this._devices = devices;
        if (this._currentDevice) {
          const found = this._devices.find((d) => d.id === this._currentDevice.id);
          this._currentDevice = found || this._devices[0] || this._currentDevice;
          if (this._currentDevice) {
            this._panel.title = `Screenshot of ${this._currentDevice.name}`;
          }
        }
        this._panel.webview.postMessage({
          command: 'devicesUpdated',
          devices: this._devices,
          currentDeviceId: this._currentDevice?.id,
        });
      })
    );

    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('deviceScreenshot.language')) {
          this._panel.webview.postMessage({
            command: 'languageUpdated',
            language: this.getLanguage(),
          });
        }
      })
    );

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready':
            this._sendInitData();
            break;

          case 'recapture':
            await this.captureAndSend();
            break;

          case 'selectDevice': {
            const found = this._devices.find((d) => d.id === message.deviceId);
            if (found) {
              this._currentDevice = found;
              this._panel.title = `Screenshot of ${found.name}`;
              await this.captureAndSend();
            }
            break;
          }

          case 'refreshDevices': {
            this._devices = await this._deviceManager.listDevices();
            if (this._devices.length > 0 && !this._devices.find((d) => d.id === this._currentDevice.id)) {
              this._currentDevice = this._devices[0];
              this._panel.title = `Screenshot of ${this._currentDevice.name}`;
            }
            this._panel.webview.postMessage({
              command: 'devicesUpdated',
              devices: this._devices,
              currentDeviceId: this._currentDevice?.id,
            });
            break;
          }

          case 'saveCustomColors': {
            if (Array.isArray(message.colors)) {
              await this._context.globalState.update('customMarkupColors', message.colors.slice(0, 3));
            }
            break;
          }

          case 'configureSaveDir': {
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
              this._panel.webview.postMessage({
                command: 'saveDirUpdated',
                saveDir: selectedPath,
              });
            }
            break;
          }

          case 'copyToClipboard': {
            await this.handleCopyToClipboard(message.dataUrl);
            break;
          }

          case 'sendToPrompt': {
            await this.handleSendToPrompt(message.dataUrl);
            break;
          }

          case 'saveImage': {
            await this.handleSaveImage(message.dataUrl, false);
            break;
          }

          case 'saveImageAs': {
            await this.handleSaveImage(message.dataUrl, true);
            break;
          }

          case 'cancel': {
            this._panel.dispose();
            break;
          }
        }
      },
      null,
      this._disposables
    );
  }

  private getLanguage(): SupportedLanguage {
    const lang = vscode.workspace.getConfiguration('deviceScreenshot').get<string>('language', 'en');
    return normalizeLanguage(lang);
  }

  private t(key: string): string {
    const lang = this.getLanguage();
    return TRANSLATIONS[lang][key] || TRANSLATIONS.en[key] || key;
  }

  private getCustomColors(): string[] {
    return this._context.globalState.get<string[]>('customMarkupColors', []);
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

  private _sendInitData() {
    this._panel.webview.postMessage({
      command: 'init',
      devices: this._devices,
      currentDeviceId: this._currentDevice.id,
      saveDir: this.getSaveDirectory(),
      customColors: this.getCustomColors(),
      language: this.getLanguage(),
    });
  }

  public sendExistingDataUrl(dataUrl: string) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    this._panel.title = `Screenshot of ${this._currentDevice.name}`;
    this._panel.webview.postMessage({
      command: 'captured',
      base64,
      device: this._currentDevice,
      devices: this._devices,
      currentDeviceId: this._currentDevice.id,
      saveDir: this.getSaveDirectory(),
      customColors: this.getCustomColors(),
      language: this.getLanguage(),
    });
  }

  public async captureAndSend() {
    this._panel.title = `Screenshot of ${this._currentDevice.name}`;
    this._panel.webview.postMessage({
      command: 'capturing',
      deviceName: this._currentDevice.name,
      devices: this._devices,
      currentDeviceId: this._currentDevice.id,
      saveDir: this.getSaveDirectory(),
    });

    try {
      const pngBuffer = await this._deviceManager.captureScreenshot(this._currentDevice);
      const base64 = pngBuffer.toString('base64');
      this._panel.webview.postMessage({
        command: 'captured',
        base64,
        byteLength: pngBuffer.byteLength,
        device: this._currentDevice,
        devices: this._devices,
        currentDeviceId: this._currentDevice.id,
        saveDir: this.getSaveDirectory(),
        customColors: this.getCustomColors(),
        language: this.getLanguage(),
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      this._panel.webview.postMessage({
        command: 'captureError',
        error: msg,
      });
      vscode.window.showErrorMessage(`${this.t('toastCaptureFailed')}${msg}`);
    }
  }

  private async handleCopyToClipboard(dataUrl: string) {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const tmpFile = path.join(os.tmpdir(), `vscode_clip_${Date.now()}.png`);
      await fs.promises.writeFile(tmpFile, buffer);

      try {
        if (process.platform === 'darwin') {
          await new Promise<void>((resolve, reject) => {
            cp.execFile(
              'osascript',
              ['-e', `set the clipboard to (read (POSIX file "${tmpFile}") as «class PNGf»)`],
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
                `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${tmpFile}'))`,
              ],
              (err) => (err ? reject(err) : resolve())
            );
          });
        } else {
          await new Promise<void>((resolve, reject) => {
            cp.execFile('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', tmpFile], (err) =>
              err ? reject(err) : resolve()
            );
          });
        }
        this._panel.webview.postMessage({
          command: 'toast',
          text: this.t('toastCopied'),
        });
      } finally {
        fs.promises.unlink(tmpFile).catch(() => {});
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to copy to clipboard: ${err?.message || err}`);
    }
  }

  private async handleSendToPrompt(dataUrl: string) {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const promptDir = path.join(os.tmpdir(), 'antigravity-device-screenshots');
      await fs.promises.mkdir(promptDir, { recursive: true });

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
        now.getHours()
      )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const safeModel = this._currentDevice.model.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(promptDir, `Screenshot_${timestamp}_${safeModel}.png`);
      await fs.promises.writeFile(filePath, buffer);

      await this.handleCopyToClipboard(dataUrl);

      const allCommands = await vscode.commands.getCommands(true);
      if (allCommands.includes('antigravity.addContext')) {
        await vscode.commands.executeCommand('antigravity.addContext', {
          type: 'file',
          uri: vscode.Uri.file(filePath).toString(),
        });
        this._panel.webview.postMessage({
          command: 'toast',
          text: this.t('toastPromptAttached'),
        });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to send to prompt: ${err?.message || err}`);
    }
  }

  private async handleSaveImage(dataUrl: string, showSaveAsDialog: boolean) {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
        now.getHours()
      )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const safeModel = this._currentDevice.model.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `Screenshot_${timestamp}_${safeModel}.png`;

      let targetPath = path.join(this.getSaveDirectory(), fileName);

      if (showSaveAsDialog) {
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
      this._panel.webview.postMessage({
        command: 'toast',
        text: `${this.t('toastSaved')}${path.basename(targetPath)}`,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save file: ${err?.message || err}`);
    }
  }

  public dispose() {
    ScreenshotPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(): string {
    const i18nJson = JSON.stringify(TRANSLATIONS);
    const initialLang = this.getLanguage();

    return /* html */ `<!DOCTYPE html>
<html lang="${initialLang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Device Screenshot</title>
  <style>
    :root {
      --bg-window: #1e1f22;
      --bg-canvas: #141517;
      --bg-control: #2b2d30;
      --bg-control-hover: #393b40;
      --border-color: #43454a;
      --text-primary: #dfe1e5;
      --text-secondary: #9da0a8;
      --accent-blue: #3574f0;
      --accent-blue-hover: #4682fa;
      --link-blue: #548af7;
    }

    * {
      box-sizing: border-box;
      user-select: none;
    }

    body {
      margin: 0;
      padding: 0;
      background-color: var(--bg-window);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    svg {
      display: block;
      flex-shrink: 0;
    }

    .top-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px 8px 16px;
      flex-wrap: wrap;
      border-bottom: 1px solid #2b2d30;
    }

    .device-group {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-right: 6px;
    }

    .btn, .select-input {
      background-color: var(--bg-control);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background-color 0.12s, border-color 0.12s;
      outline: none;
    }

    .btn:hover:not(:disabled), .select-input:hover:not(:disabled) {
      background-color: var(--bg-control-hover);
      border-color: #5a5d63;
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-primary {
      background-color: var(--accent-blue);
      border-color: var(--accent-blue);
      color: #ffffff;
      font-weight: 600;
      padding: 6px 18px;
    }

    .btn-primary:hover:not(:disabled) {
      background-color: var(--accent-blue-hover);
      border-color: var(--accent-blue-hover);
    }

    .btn-icon-only {
      padding: 6px 8px;
    }

    .spacer {
      flex: 1;
    }

    /* High-Clarity Markup Bar */
    .markup-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 16px;
      background-color: #25262a;
      border-bottom: 1px solid #2b2d30;
      flex-wrap: wrap;
      position: relative;
    }

    .color-palette {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .color-dot {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.28);
      cursor: pointer;
      padding: 0;
      transition: transform 0.12s, border-color 0.12s;
    }

    .color-dot:hover {
      transform: scale(1.1);
    }

    .color-dot.active {
      border-color: #ffffff;
      transform: scale(1.18);
      box-shadow: 0 0 0 2px rgba(53, 116, 240, 0.7);
    }

    .custom-colors-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #1b1c1f;
      border: 1px solid #3a3c42;
      border-radius: 6px;
      padding: 2px 6px;
    }

    .custom-colors-container {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .color-dot.custom-dot {
      border-radius: 4px;
      width: 17px;
      height: 17px;
    }

    .custom-slot-empty {
      width: 17px;
      height: 17px;
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
      width: 21px;
      height: 21px;
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
      transition: transform 0.12s, border-color 0.12s;
    }

    .picker-trigger-btn:hover {
      transform: scale(1.12);
      border-color: #ffffff;
      border-style: solid;
    }

    .picker-trigger-inner {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #25262a;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }

    .color-picker-popover {
      position: absolute;
      top: calc(100% + 4px);
      left: 380px;
      background: #2b2d30;
      border: 1px solid #4e5157;
      border-radius: 8px;
      padding: 8px 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
      display: none;
      flex-direction: column;
      gap: 6px;
      z-index: 50;
      min-width: 220px;
    }

    .color-picker-popover.visible {
      display: flex;
    }

    .picker-popover-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
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
      border: 1px solid var(--border-color);
      border-radius: 5px;
      background: none;
      cursor: pointer;
    }

    .hex-input {
      background: #1e1f22;
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 5px;
      padding: 4px 7px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      width: 90px;
      outline: none;
      text-transform: uppercase;
    }

    .stroke-size-group {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: #1b1c1f;
      border: 1px solid #3a3c42;
      border-radius: 6px;
      padding: 2px 4px;
    }

    .stroke-size-btn {
      width: 24px;
      height: 22px;
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
      border-color: var(--accent-blue);
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

    .sub-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 16px;
      background-color: var(--bg-window);
    }

    .zoom-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .icon-btn {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid transparent;
      border-radius: 5px;
      padding: 4px 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      cursor: pointer;
      font-size: 12.5px;
    }

    .icon-btn:hover:not(:disabled) {
      background-color: var(--bg-control);
      color: var(--text-primary);
    }

    .icon-btn.active {
      background-color: rgba(53, 116, 240, 0.28);
      color: #ffffff;
      border-color: var(--accent-blue);
    }

    .icon-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .divider {
      width: 1px;
      height: 16px;
      background-color: var(--border-color);
      margin: 0 4px;
    }

    .meta-info {
      color: var(--text-primary);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }

    .viewport {
      flex: 1;
      background-color: var(--bg-canvas);
      margin: 0 16px;
      border-radius: 6px;
      border: 1px solid #28292d;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .viewport.mode-pan { cursor: grab; }
    .viewport.mode-pan.dragging { cursor: grabbing; }
    .viewport.mode-draw { cursor: crosshair; }
    .viewport.mode-text { cursor: text; }

    .canvas-wrapper {
      position: relative;
      transform-origin: center center;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
      line-height: 0;
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
      border: 1.5px solid var(--accent-blue);
      border-radius: 4px;
      padding: 4px 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 700;
      font-size: 15px;
      outline: none;
      z-index: 25;
      min-width: 120px;
    }

    .crop-confirm-bar {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 31, 34, 0.96);
      border: 1px solid var(--accent-blue);
      border-radius: 20px;
      padding: 5px 12px;
      display: none;
      align-items: center;
      gap: 8px;
      z-index: 22;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
    }

    .crop-confirm-bar.visible {
      display: flex;
    }

    .loading-overlay {
      position: absolute;
      inset: 0;
      background: rgba(20, 21, 23, 0.78);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      z-index: 10;
    }

    .loading-overlay.visible {
      display: flex;
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(255, 255, 255, 0.15);
      border-top-color: var(--accent-blue);
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .toast {
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(43, 45, 48, 0.96);
      border: 1px solid var(--border-color);
      color: #fff;
      padding: 8px 16px;
      border-radius: 6px;
      font-weight: 500;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
      z-index: 20;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .bottom-area {
      padding: 12px 16px 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .setting-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .setting-label {
      color: var(--text-primary);
      min-width: 155px;
    }

    .save-path {
      color: var(--text-primary);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .configure-link {
      color: var(--link-blue);
      background: none;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      padding: 2px 6px;
    }

    .configure-link:hover {
      text-decoration: underline;
    }

    .footer-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 2px;
    }

    .help-circle {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      cursor: help;
    }

    .action-buttons {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="device-group">
      <select id="deviceSelect" class="select-input" title="Select Device"></select>
      <button id="refreshDevicesBtn" class="btn btn-icon-only" title="Refresh">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
          <path d="M13.5 2v2.5H11"/>
        </svg>
      </button>
    </div>

    <button id="recaptureBtn" class="btn" title="Recapture (R)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
        <path d="M13.5 2v2.5H11"/>
      </svg>
      <span id="recaptureLabel">Recapture</span>
    </button>
    <button id="rotateLeftBtn" class="btn" title="Rotate Left">Rotate Left</button>
    <button id="rotateRightBtn" class="btn" title="Rotate Right">Rotate Right</button>
    <button id="copyBtn" class="btn" title="Copy to Clipboard (Cmd+C)">Copy to Clipboard</button>
    <button id="sendPromptBtn" class="btn btn-primary" title="Send to Prompt">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2L7.5 8.5"/>
        <path d="M14 2L9.5 14L7.5 8.5L2 6.5L14 2Z"/>
      </svg>
      <span id="sendPromptLabel">Send to Prompt</span>
    </button>

    <div class="spacer"></div>

    <select id="shapeSelect" class="select-input" title="Shape">
      <option id="optShapeRect" value="rectangular">Rectangular</option>
      <option id="optShapeRounded" value="rounded">Rounded Corners</option>
    </select>
  </div>

  <!-- High-Clarity Markup & Custom Color Bar -->
  <div class="markup-bar">
    <button class="icon-btn tool-btn active" data-tool="pan" title="Move / Pan">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 1.5v13M1.5 8h13"/>
        <path d="M6 3.5L8 1.5l2 2M6 12.5L8 14.5l2-2M3.5 6L1.5 8l2 2M12.5 6l2 2-2 2"/>
      </svg>
      <span id="toolMoveLabel">Move</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="pen" title="Pen">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11.2 2.2a1.6 1.6 0 0 1 2.3 2.3L5.3 12.7 2 13.7l1-3.3 8.2-8.2z"/>
        <path d="M9.5 3.9l2.3 2.3"/>
      </svg>
      <span id="toolPenLabel">Pen</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="eraser" title="Eraser">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8.8 2.5l4.7 4.7a1.4 1.4 0 0 1 0 2l-4.6 4.6H4.3L2.2 11.7a1.4 1.4 0 0 1 0-2L6.8 2.5a1.4 1.4 0 0 1 2 0z"/>
        <path d="M5.4 5.9l4.7 4.7"/>
        <line x1="8.5" y1="13.8" x2="14" y2="13.8"/>
      </svg>
      <span id="toolEraserLabel">Eraser</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="highlighter" title="Highlighter">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.8 1.8l3.4 3.4-5.2 5.2H4.6V7l5.2-5.2z"/>
        <path d="M4.6 10.4L3 12h3.5l1.5-1.6"/>
        <line x1="2.5" y1="14.2" x2="13.5" y2="14.2" stroke-width="2.4" stroke-opacity="0.75"/>
      </svg>
      <span id="toolHighlighterLabel">Highlighter</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="rect" title="Rectangle">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.5"/>
      </svg>
      <span id="toolRectLabel">Rectangle</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="circle" title="Circle">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="8" cy="8" r="5.4"/>
      </svg>
      <span id="toolCircleLabel">Circle</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="arrow" title="Arrow">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <line x1="2.8" y1="13.2" x2="12.2" y2="3.8"/>
        <polyline points="6.5 3.2 12.8 3.2 12.8 9.5"/>
      </svg>
      <span id="toolArrowLabel">Arrow</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="text" title="Text">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.5 3.5h9M8 3.5v9.5M5.8 13h4.4"/>
        <path d="M3.5 5.2V3.5M12.5 5.2V3.5" stroke-width="1.4"/>
      </svg>
      <span id="toolTextLabel">Text</span>
    </button>
    <button class="icon-btn tool-btn" data-tool="crop" title="Crop">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4.2 1.5v10.3h10.3"/>
        <path d="M1.5 4.2h10.3v10.3"/>
      </svg>
      <span id="toolCropLabel">Crop</span>
    </button>

    <div class="divider"></div>

    <div class="color-palette">
      <button class="color-dot preset-dot active" data-color="#ff3b30" style="background: #ff3b30;" title="Red"></button>
      <button class="color-dot preset-dot" data-color="#ffcc00" style="background: #ffcc00;" title="Yellow"></button>
      <button class="color-dot preset-dot" data-color="#34c759" style="background: #34c759;" title="Green"></button>
      <button class="color-dot preset-dot" data-color="#007aff" style="background: #007aff;" title="Blue"></button>
      <button class="color-dot preset-dot" data-color="#ffffff" style="background: #ffffff;" title="White"></button>

      <div class="divider" style="height: 14px; margin: 0 2px;"></div>

      <div class="custom-colors-group" title="Custom Colors (Max 3)">
        <div id="customColorsContainer" class="custom-colors-container"></div>

        <button id="colorPickerBtn" class="picker-trigger-btn" title="Custom Color Picker">
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
      <button class="stroke-size-btn active" data-size="6" id="btnStrokeMed" title="Medium">
        <span class="stroke-dot-circle" style="width: 7px; height: 7px;"></span>
      </button>
      <button class="stroke-size-btn" data-size="10" id="btnStrokeThick" title="Thick">
        <span class="stroke-dot-circle" style="width: 11px; height: 11px;"></span>
      </button>
    </div>

    <div class="divider"></div>

    <button id="undoBtn" class="icon-btn" disabled title="Undo (Cmd+Z)">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h7a3.5 3.5 0 1 1 0 7H6"/>
        <path d="M5.5 3.5L3 6l2.5 2.5"/>
      </svg>
      <span id="undoLabel">Undo</span>
    </button>
    <button id="resetAllBtn" class="icon-btn" disabled title="Reset to Original">
      <span id="resetLabel">Reset to Original</span>
    </button>

    <!-- Floating Color Picker Popover -->
    <div id="colorPickerPopover" class="color-picker-popover">
      <div class="picker-popover-title">
        <span id="pickerTitleText">Custom Color (Max 3 saved)</span>
        <button id="closePickerBtn" class="icon-btn" style="padding: 1px 4px;">✕</button>
      </div>
      <div class="picker-controls-row">
        <input id="nativeColorInput" type="color" class="native-color-well" value="#ff5500" />
        <input id="hexColorInput" type="text" class="hex-input" value="#FF5500" maxlength="7" placeholder="#RRGGBB" />
        <button id="applyCustomColorBtn" class="btn btn-primary" style="padding: 4px 10px; font-size: 11.5px;">Apply</button>
      </div>
    </div>
  </div>

  <div class="sub-bar">
    <div class="zoom-controls">
      <button id="fitBtn" class="icon-btn" title="Fit to Window">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>
        </svg>
      </button>
      <button id="gridBtn" class="icon-btn" title="Toggle Pixel Grid">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="2" y="2" width="12" height="12" rx="1"/>
          <line x1="6" y1="2" x2="6" y2="14"/>
          <line x1="10" y1="2" x2="10" y2="14"/>
          <line x1="2" y1="6" x2="14" y2="6"/>
          <line x1="2" y1="10" x2="14" y2="10"/>
        </svg>
      </button>
      <div class="divider"></div>
      <button id="zoomInBtn" class="icon-btn" title="Zoom In (+)">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="6"/>
          <line x1="8" y1="5" x2="8" y2="11"/>
          <line x1="5" y1="8" x2="11" y2="8"/>
        </svg>
      </button>
      <button id="zoomOutBtn" class="icon-btn" title="Zoom Out (-)">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="6"/>
          <line x1="5" y1="8" x2="11" y2="8"/>
        </svg>
      </button>
      <button id="actualSizeBtn" class="icon-btn" title="Actual Size (1:1)">1:1</button>
      <span id="zoomBadge" style="color: var(--text-secondary); font-size: 12px; margin-left: 6px;">100%</span>
    </div>
    <div id="metaInfo" class="meta-info">Loading...</div>
  </div>

  <div id="viewport" class="viewport mode-pan">
    <div id="canvasWrapper" class="canvas-wrapper">
      <canvas id="previewCanvas"></canvas>
      <div id="gridOverlay" class="grid-overlay"></div>
    </div>

    <input id="floatingTextInput" type="text" class="floating-text-input" placeholder="Enter text (Enter)" />

    <div id="cropConfirmBar" class="crop-confirm-bar">
      <span id="cropSelectedText" style="font-size: 12px;">Area selected</span>
      <button id="applyCropBtn" class="btn btn-primary" style="padding: 4px 12px; font-size: 12px;">Apply Crop</button>
      <button id="cancelCropBtn" class="btn" style="padding: 4px 10px; font-size: 12px;">Cancel</button>
    </div>

    <div id="loadingOverlay" class="loading-overlay">
      <div class="spinner"></div>
      <div id="loadingText">Capturing screen...</div>
    </div>

    <div id="toast" class="toast"></div>
  </div>

  <div class="bottom-area">
    <div class="setting-row">
      <span id="resolutionLabel" class="setting-label">Resolution (% of native):</span>
      <select id="resolutionSelect" class="select-input" style="min-width: 90px;">
        <option value="100">100</option>
        <option value="75">75</option>
        <option value="50">50</option>
        <option value="25">25</option>
      </select>
    </div>

    <div class="setting-row">
      <span id="savingToLabel" class="setting-label" style="min-width: 75px;">Save to:</span>
      <span id="saveDirText" class="save-path">~/Desktop</span>
      <button id="configureDirBtn" class="configure-link">Configure</button>
    </div>

    <div class="footer-actions">
      <div class="help-circle" title="Wheel: Zoom | Cmd+Z: Undo | Cmd+C: Copy | Cmd+S: Save">?</div>
      <div class="action-buttons">
        <button id="cancelBtn" class="btn">Cancel</button>
        <button id="saveAsBtn" class="btn">Save As...</button>
        <button id="saveBtn" class="btn btn-primary">Save</button>
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

    const deviceSelect = document.getElementById('deviceSelect');
    const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
    const recaptureBtn = document.getElementById('recaptureBtn');
    const rotateLeftBtn = document.getElementById('rotateLeftBtn');
    const rotateRightBtn = document.getElementById('rotateRightBtn');
    const copyBtn = document.getElementById('copyBtn');
    const sendPromptBtn = document.getElementById('sendPromptBtn');
    const shapeSelect = document.getElementById('shapeSelect');

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

    const fitBtn = document.getElementById('fitBtn');
    const gridBtn = document.getElementById('gridBtn');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const actualSizeBtn = document.getElementById('actualSizeBtn');
    const zoomBadge = document.getElementById('zoomBadge');
    const metaInfo = document.getElementById('metaInfo');

    const viewport = document.getElementById('viewport');
    const canvasWrapper = document.getElementById('canvasWrapper');
    const canvas = document.getElementById('previewCanvas');
    const ctx = canvas.getContext('2d');
    const annotationLayerCanvas = document.createElement('canvas');
    const annotationLayerCtx = annotationLayerCanvas.getContext('2d');
    const gridOverlay = document.getElementById('gridOverlay');
    const floatingTextInput = document.getElementById('floatingTextInput');
    const cropConfirmBar = document.getElementById('cropConfirmBar');
    const applyCropBtn = document.getElementById('applyCropBtn');
    const cancelCropBtn = document.getElementById('cancelCropBtn');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const toast = document.getElementById('toast');

    const resolutionSelect = document.getElementById('resolutionSelect');
    const saveDirText = document.getElementById('saveDirText');
    const configureDirBtn = document.getElementById('configureDirBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const saveAsBtn = document.getElementById('saveAsBtn');
    const saveBtn = document.getElementById('saveBtn');

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
    let cachedDevices = [];
    let cachedCurrentDeviceId = null;

    let viewZoom = 1;
    let panX = 0;
    let panY = 0;
    let isPointerDown = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let eraserCursorPos = null;

    function applyTranslations() {
      document.getElementById('recaptureLabel').textContent = t('recapture');
      rotateLeftBtn.textContent = t('rotateLeft');
      rotateRightBtn.textContent = t('rotateRight');
      copyBtn.textContent = t('copyClipboard');
      document.getElementById('sendPromptLabel').textContent = t('sendToPrompt');
      document.getElementById('toolMoveLabel').textContent = t('toolMove');
      document.getElementById('toolPenLabel').textContent = t('toolPen');
      document.getElementById('toolEraserLabel').textContent = t('toolEraser');
      document.getElementById('toolHighlighterLabel').textContent = t('toolHighlighter');
      document.getElementById('toolRectLabel').textContent = t('toolRect');
      document.getElementById('toolCircleLabel').textContent = t('toolCircle');
      document.getElementById('toolArrowLabel').textContent = t('toolArrow');
      document.getElementById('toolTextLabel').textContent = t('toolText');
      document.getElementById('toolCropLabel').textContent = t('toolCrop');
      document.getElementById('btnStrokeThin').title = t('strokeThin');
      document.getElementById('btnStrokeMed').title = t('strokeMedium');
      document.getElementById('btnStrokeThick').title = t('strokeThick');
      document.getElementById('undoLabel').textContent = t('undo').replace(' (Cmd+Z)', '');
      document.getElementById('resetLabel').textContent = t('resetOriginalFull');
      document.getElementById('pickerTitleText').textContent = t('customColorTitle');
      applyCustomColorBtn.textContent = t('apply');
      floatingTextInput.placeholder = t('textPlaceholder');
      document.getElementById('cropSelectedText').textContent = t('cropSelected');
      applyCropBtn.textContent = t('applyCrop');
      cancelCropBtn.textContent = t('cancel');
      document.getElementById('resolutionLabel').textContent = t('resolutionLabel');
      document.getElementById('savingToLabel').textContent = t('saveLocation');
      configureDirBtn.textContent = t('configure');
      cancelBtn.textContent = t('cancel');
      saveAsBtn.textContent = t('saveAs');
      saveBtn.textContent = t('save');
      document.getElementById('optShapeRect').textContent = t('shapeRectangular');
      document.getElementById('optShapeRounded').textContent = t('shapeRoundedFull');
      gridBtn.title = t('gridToggle');
      fitBtn.title = t('fitToWindow');
      zoomInBtn.title = t('zoomIn');
      zoomOutBtn.title = t('zoomOut');
      actualSizeBtn.title = t('actualSize');
      if (cachedDevices.length > 0) {
        populateDevices(cachedDevices, cachedCurrentDeviceId);
      }
      renderCustomColors();
    }

    function showToast(msg) {
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(showToast._timer);
      showToast._timer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2200);
    }

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
          dot.title = \`Custom #\${i + 1} (\${hex.toUpperCase()})\`;
          dot.addEventListener('click', () => selectColor(hex));
          customColorsContainer.appendChild(dot);
        } else {
          const emptySlot = document.createElement('button');
          emptySlot.className = 'custom-slot-empty';
          emptySlot.title = \`Custom Slot #\${i + 1}\`;
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

    function pushHistorySnapshot() {
      if (!workingImage) return;
      historyStack.push({
        workingImageSrc: workingImage.src,
        rotationDegrees,
        annotations: JSON.parse(JSON.stringify(annotations)),
      });
      if (historyStack.length > 30) historyStack.shift();
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
      eraserCursorPos = null;
      cropConfirmBar.classList.remove('visible');
      activeTool = tool;
      toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
      strokeSizeGroup.classList.toggle('eraser-mode', tool === 'eraser');
      viewport.classList.remove('mode-pan', 'mode-draw', 'mode-text');
      if (tool === 'pan') viewport.classList.add('mode-pan');
      else if (tool === 'text') viewport.classList.add('mode-text');
      else viewport.classList.add('mode-draw');
      renderCanvas(false);
    }

    toolBtns.forEach((btn) => btn.addEventListener('click', () => setActiveTool(btn.dataset.tool)));

    strokeSizeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        strokeWidth = parseInt(btn.dataset.size, 10) || 6;
        strokeSizeBtns.forEach((b) => b.classList.toggle('active', b === btn));
        if (activeTool === 'eraser' && eraserCursorPos) {
          renderCanvas(false);
        }
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

    function populateDevices(devices, currentId) {
      cachedDevices = devices || [];
      cachedCurrentDeviceId = currentId;
      deviceSelect.innerHTML = '';
      if (!devices || devices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = t('emptyTitle');
        deviceSelect.appendChild(opt);
        return;
      }
      devices.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        const transportLabel = d.transport === 'wifi' ? 'Wi-Fi' : 'USB';
        const badge =
          d.reality === 'physical'
            ? d.platform === 'android'
              ? \`[Android \${transportLabel}]\`
              : \`[iPhone \${transportLabel}]\`
            : d.platform === 'android'
            ? t('androidEmulator')
            : t('iosSimulator');
        opt.textContent = \`\${badge} \${d.name}\`;
        if (d.id === currentId) opt.selected = true;
        deviceSelect.appendChild(opt);
      });
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

      if (ann.type === 'eraser') {
        context.globalCompositeOperation = 'destination-out';
        context.strokeStyle = 'rgba(0,0,0,1)';
        context.fillStyle = 'rgba(0,0,0,1)';
        context.lineWidth = lineW * 3.8;
        const pts = ann.points || [];
        if (pts.length === 1) {
          context.beginPath();
          context.arc(pts[0].x, pts[0].y, (lineW * 3.8) / 2, 0, Math.PI * 2);
          context.fill();
        } else if (pts.length > 1) {
          context.beginPath();
          context.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) context.lineTo(pts[i].x, pts[i].y);
          context.stroke();
        }
      } else if (ann.type === 'pen' || ann.type === 'highlighter') {
        if (ann.type === 'highlighter') {
          context.globalAlpha = 0.38;
          context.lineWidth = lineW * 2.8;
        }
        const pts = ann.points || [];
        if (pts.length > 0) {
          context.beginPath();
          context.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) context.lineTo(pts[i].x, pts[i].y);
          context.stroke();
        }
      } else if (ann.type === 'rect') {
        context.strokeRect(
          Math.min(ann.x1, ann.x2),
          Math.min(ann.y1, ann.y2),
          Math.abs(ann.x2 - ann.x1),
          Math.abs(ann.y2 - ann.y1)
        );
      } else if (ann.type === 'circle') {
        context.beginPath();
        context.ellipse(
          (ann.x1 + ann.x2) / 2,
          (ann.y1 + ann.y2) / 2,
          Math.abs(ann.x2 - ann.x1) / 2,
          Math.abs(ann.y2 - ann.y1) / 2,
          0,
          0,
          Math.PI * 2
        );
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
        annotationLayerCanvas.width = targetW;
        annotationLayerCanvas.height = targetH;
        annotationLayerCtx.clearRect(0, 0, targetW, targetH);
        for (const ann of annotations) drawSingleAnnotation(annotationLayerCtx, ann);
        if (currentDraftAnnotation) drawSingleAnnotation(annotationLayerCtx, currentDraftAnnotation);
        ctx.drawImage(annotationLayerCanvas, 0, 0);
      }

      if (includeCropOverlay && activeTool === 'eraser' && eraserCursorPos) {
        const dpiScale = Math.max(1, Math.min(targetW, targetH) / 500);
        const eraserRadius = (strokeWidth * dpiScale * 3.8) / 2;
        const borderScale = Math.max(1, 1 / Math.max(0.15, viewZoom));
        ctx.save();
        ctx.beginPath();
        ctx.arc(eraserCursorPos.x, eraserCursorPos.y, eraserRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 59, 48, 0.22)';
        ctx.fill();
        ctx.lineWidth = 2.8 * borderScale;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.88)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(eraserCursorPos.x, eraserCursorPos.y, eraserRadius, 0, Math.PI * 2);
        ctx.lineWidth = 1.4 * borderScale;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(eraserCursorPos.x, eraserCursorPos.y, 2 * borderScale, 0, Math.PI * 2);
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
      const kbSize = (Math.round((base64Length * 3) / 4) / 1024).toFixed(2);
      metaInfo.textContent = \`\${targetW.toLocaleString()}x\${targetH.toLocaleString()} PNG (32-bit color) \${kbSize} kB\`;

      if (fitAfterRender) fitToViewport();
      else applyTransform();
      updateHistoryButtons();
    }

    function getCleanExportDataUrl() {
      renderCanvas(false, false);
      const url = canvas.toDataURL('image/png');
      if (pendingCropRect || (activeTool === 'eraser' && eraserCursorPos)) renderCanvas(false, true);
      return url;
    }

    function fitToViewport() {
      if (!canvas.width || !canvas.height) return;
      const pad = 32;
      const vw = Math.max(100, viewport.clientWidth - pad);
      const vh = Math.max(100, viewport.clientHeight - pad);
      viewZoom = Math.min(vw / canvas.width, vh / canvas.height, 1);
      panX = 0;
      panY = 0;
      applyTransform();
    }

    function applyTransform() {
      canvas.style.width = Math.round(canvas.width * viewZoom) + 'px';
      canvas.style.height = Math.round(canvas.height * viewZoom) + 'px';
      canvasWrapper.style.transform = \`translate(\${panX}px, \${panY}px)\`;
      zoomBadge.textContent = \`\${Math.round(viewZoom * 100)}%\`;
    }

    function clientToCanvasCoords(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(canvas.width, (clientX - rect.left) * (canvas.width / rect.width))),
        y: Math.max(0, Math.min(canvas.height, (clientY - rect.top) * (canvas.height / rect.height))),
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
      offscreen
        .getContext('2d')
        .drawImage(
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
      const newImg = new Image();
      newImg.onload = () => {
        workingImage = newImg;
        rotationDegrees = 0;
        annotations = [];
        setActiveTool('pan');
        renderCanvas(true);
        showToast(t('toastCropped'));
      };
      newImg.src = offscreen.toDataURL('image/png');
    });

    cancelCropBtn.addEventListener('click', () => {
      pendingCropRect = null;
      cropConfirmBar.classList.remove('visible');
      renderCanvas(false);
    });

    viewport.addEventListener('mousedown', (e) => {
      if (!workingImage || e.button !== 0) return;
      if (e.target === floatingTextInput || cropConfirmBar.contains(e.target)) return;

      if (activeTool === 'text') {
        commitFloatingText();
        pendingTextPos = clientToCanvasCoords(e.clientX, e.clientY);
        const vpRect = viewport.getBoundingClientRect();
        floatingTextInput.style.left = Math.min(vpRect.width - 140, Math.max(8, e.clientX - vpRect.left)) + 'px';
        floatingTextInput.style.top = Math.min(vpRect.height - 40, Math.max(8, e.clientY - vpRect.top)) + 'px';
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
        if (activeTool === 'eraser') {
          eraserCursorPos = { x: pt.x, y: pt.y };
        }
        currentDraftAnnotation = {
          type: activeTool,
          color: activeColor,
          size: strokeWidth,
          points: [{ x: pt.x, y: pt.y }],
        };
        if (activeTool === 'eraser') {
          renderCanvas(false, true);
        }
      } else {
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

    viewport.addEventListener('mousemove', (e) => {
      if (!workingImage || activeTool !== 'eraser' || isPointerDown) return;
      eraserCursorPos = clientToCanvasCoords(e.clientX, e.clientY);
      renderCanvas(false, true);
    });

    viewport.addEventListener('mouseleave', () => {
      if (activeTool === 'eraser' && eraserCursorPos && !isPointerDown) {
        eraserCursorPos = null;
        renderCanvas(false, false);
      }
    });

    window.addEventListener('mousemove', (e) => {
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
          if (activeTool === 'eraser') {
            eraserCursorPos = { x: pt.x, y: pt.y };
          }
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

    deviceSelect.addEventListener('change', () => {
      if (deviceSelect.value) vscode.postMessage({ command: 'selectDevice', deviceId: deviceSelect.value });
    });

    refreshDevicesBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshDevices' });
      showToast(t('scanningDevices'));
    });

    recaptureBtn.addEventListener('click', () => vscode.postMessage({ command: 'recapture' }));

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

    shapeSelect.addEventListener('change', () => {
      shapeMode = shapeSelect.value;
      renderCanvas(false);
    });

    resolutionSelect.addEventListener('change', () => {
      scalePercent = parseInt(resolutionSelect.value, 10) || 100;
      renderCanvas(true);
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

    cancelBtn.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
    configureDirBtn.addEventListener('click', () => vscode.postMessage({ command: 'configureSaveDir' }));
    fitBtn.addEventListener('click', () => fitToViewport());

    gridBtn.addEventListener('click', () => {
      gridBtn.classList.toggle('active');
      gridOverlay.classList.toggle('visible');
    });

    zoomInBtn.addEventListener('click', () => {
      viewZoom = Math.min(8, viewZoom * 1.25);
      applyTransform();
    });

    zoomOutBtn.addEventListener('click', () => {
      viewZoom = Math.max(0.1, viewZoom / 1.25);
      applyTransform();
    });

    actualSizeBtn.addEventListener('click', () => {
      viewZoom = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    });

    viewport.addEventListener(
      'wheel',
      (e) => {
        if (!workingImage) return;
        e.preventDefault();
        viewZoom = Math.min(8, Math.max(0.1, viewZoom * (e.deltaY < 0 ? 1.12 : 0.89)));
        applyTransform();
      },
      { passive: false }
    );

    window.addEventListener('resize', () => {
      if (workingImage) fitToViewport();
    });

    window.addEventListener('keydown', (e) => {
      if (document.activeElement === floatingTextInput || document.activeElement === hexColorInput) return;
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
        case 'init':
          if (msg.language) {
            currentLang = msg.language;
            applyTranslations();
          }
          populateDevices(msg.devices, msg.currentDeviceId);
          if (msg.saveDir) saveDirText.textContent = msg.saveDir;
          if (Array.isArray(msg.customColors)) {
            customColors = msg.customColors.slice(0, 3);
            renderCustomColors();
          }
          break;

        case 'languageUpdated':
          if (msg.language) {
            currentLang = msg.language;
            applyTranslations();
          }
          break;

        case 'capturing':
          loadingText.textContent = \`\${msg.deviceName || ''} · \${t('capturingDevice')}\`;
          loadingOverlay.classList.add('visible');
          if (msg.devices) populateDevices(msg.devices, msg.currentDeviceId);
          if (msg.saveDir) saveDirText.textContent = msg.saveDir;
          break;

        case 'captured':
          loadingOverlay.classList.remove('visible');
          if (msg.language) {
            currentLang = msg.language;
            applyTranslations();
          }
          if (msg.devices) populateDevices(msg.devices, msg.currentDeviceId);
          if (msg.saveDir) saveDirText.textContent = msg.saveDir;
          if (Array.isArray(msg.customColors)) {
            customColors = msg.customColors.slice(0, 3);
            renderCustomColors();
          }

          const img = new Image();
          img.onload = () => {
            rawSourceImage = img;
            workingImage = img;
            rotationDegrees = 0;
            annotations = [];
            historyStack = [];
            pendingCropRect = null;
            cropConfirmBar.classList.remove('visible');
            renderCanvas(true);
          };
          img.src = 'data:image/png;base64,' + msg.base64;
          break;

        case 'captureError':
          loadingOverlay.classList.remove('visible');
          metaInfo.textContent = 'Capture Failed';
          break;

        case 'devicesUpdated':
          populateDevices(msg.devices, msg.currentDeviceId);
          break;

        case 'saveDirUpdated':
          saveDirText.textContent = msg.saveDir;
          showToast(t('toastSaveDirUpdated'));
          break;

        case 'toast':
          showToast(msg.text);
          break;
      }
    });

    applyTranslations();
    renderCustomColors();
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
