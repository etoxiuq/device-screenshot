import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { MobileDevice } from './deviceManager';

export interface LaunchConfigItem {
  key: string;
  name: string;
  label: string;
  folderUri?: string;
  isCompound?: boolean;
  configType?: string;
}

export interface LaunchStateSnapshot {
  configs: LaunchConfigItem[];
  selectedKey: string;
  isDebugging: boolean;
  isFlutterOrDart: boolean;
  activeSessionName: string;
  runningDeviceIds: string[];
}

const SELECTED_LAUNCH_KEY_STATE = 'deviceScreenshot.selectedLaunchKey';
const DEFAULT_LAUNCH_KEY = '__default__';

export class LaunchManager implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _activeSessions = new Map<string, vscode.DebugSession>();
  private readonly _onDidChangeState = new vscode.EventEmitter<LaunchStateSnapshot>();
  public readonly onDidChangeState: vscode.Event<LaunchStateSnapshot> = this._onDidChangeState.event;

  constructor(private readonly _context: vscode.ExtensionContext) {
    if (vscode.debug.activeDebugSession) {
      this._activeSessions.set(vscode.debug.activeDebugSession.id, vscode.debug.activeDebugSession);
    }

    this._disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this._activeSessions.set(session.id, session);
        this.emitState();
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this._activeSessions.delete(session.id);
        this.emitState();
      }),
      vscode.debug.onDidChangeActiveDebugSession((session) => {
        if (session) {
          this._activeSessions.set(session.id, session);
        }
        this.emitState();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('launch')) {
          this.emitState();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.emitState();
      })
    );
  }

  public dispose(): void {
    this._onDidChangeState.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }

  public emitState(): void {
    this._onDidChangeState.fire(this.getState());
  }

  public getLaunchConfigs(): {
    items: LaunchConfigItem[];
    rawMap: Map<string, { folder?: vscode.WorkspaceFolder; config?: vscode.DebugConfiguration; compoundName?: string }>;
  } {
    const folders = vscode.workspace.workspaceFolders || [];
    const multiRoot = folders.length > 1;
    const items: LaunchConfigItem[] = [];
    const rawMap = new Map<
      string,
      { folder?: vscode.WorkspaceFolder; config?: vscode.DebugConfiguration; compoundName?: string }
    >();

    for (const folder of folders) {
      const launchCfg = vscode.workspace.getConfiguration('launch', folder.uri);
      const configs = launchCfg.get<vscode.DebugConfiguration[]>('configurations', []) || [];
      const compounds = launchCfg.get<Array<{ name?: string; configurations?: unknown[] }>>('compounds', []) || [];

      for (const cfg of configs) {
        if (!cfg || !cfg.name) {
          continue;
        }
        const key = `${folder.uri.toString()}::config::${cfg.name}`;
        items.push({
          key,
          name: cfg.name,
          label: multiRoot ? `${folder.name}: ${cfg.name}` : cfg.name,
          folderUri: folder.uri.toString(),
          isCompound: false,
          configType: cfg.type,
        });
        rawMap.set(key, { folder, config: cfg });
      }

      for (const comp of compounds) {
        if (!comp || !comp.name) {
          continue;
        }
        const key = `${folder.uri.toString()}::compound::${comp.name}`;
        items.push({
          key,
          name: comp.name,
          label: multiRoot ? `${folder.name}: [Compound] ${comp.name}` : `[Compound] ${comp.name}`,
          folderUri: folder.uri.toString(),
          isCompound: true,
        });
        rawMap.set(key, { folder, compoundName: comp.name });
      }
    }

    return { items, rawMap };
  }

  public getSelectedKey(items?: LaunchConfigItem[]): string {
    const list = items ?? this.getLaunchConfigs().items;
    if (list.length === 0) {
      return DEFAULT_LAUNCH_KEY;
    }
    const saved = this._context.workspaceState.get<string>(SELECTED_LAUNCH_KEY_STATE);
    if (saved && list.some((i) => i.key === saved)) {
      return saved;
    }
    return list[0].key;
  }

  public async setSelectedKey(key: string): Promise<void> {
    await this._context.workspaceState.update(SELECTED_LAUNCH_KEY_STATE, key);
    this.emitState();
  }

  public getState(): LaunchStateSnapshot {
    const { items } = this.getLaunchConfigs();
    const selectedKey = this.getSelectedKey(items);

    const active = vscode.debug.activeDebugSession;
    const sessions = Array.from(this._activeSessions.values());
    if (active && !this._activeSessions.has(active.id)) {
      sessions.push(active);
    }

    const isDebugging = sessions.length > 0;
    const isFlutterOrDart = sessions.some((s) => s.type === 'dart');
    const activeSessionName = active?.name || sessions[sessions.length - 1]?.name || '';

    const runningDeviceIds: string[] = [];
    for (const s of sessions) {
      const devId = s.configuration?.deviceId;
      if (typeof devId === 'string' && devId && !runningDeviceIds.includes(devId)) {
        runningDeviceIds.push(devId);
      }
    }

    return {
      configs: items,
      selectedKey,
      isDebugging,
      isFlutterOrDart,
      activeSessionName,
      runningDeviceIds,
    };
  }

  /**
   * Reads Flutter's currently selected device ID if the Dart/Flutter extension is active.
   */
  public async getIdeSelectedDeviceId(): Promise<string | undefined> {
    try {
      const dartExt = vscode.extensions.getExtension('Dart-Code.dart-code');
      if (!dartExt || !dartExt.isActive) {
        return undefined;
      }
      const id = await vscode.commands.executeCommand<string>('flutter.getSelectedDeviceId');
      return typeof id === 'string' && id.trim() ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Synchronizes the selected device with Flutter/Dart-Code's status bar & device manager
   * via Dart Tooling Daemon (`Editor.selectDevice`) without popping up any UI.
   */
  public async syncIdeSelectedDevice(device: MobileDevice): Promise<boolean> {
    return this.syncIdeSelectedDeviceById(device.id);
  }

  public async syncIdeSelectedDeviceById(deviceId: string): Promise<boolean> {
    if (!deviceId) {
      return false;
    }
    try {
      const dartExt = vscode.extensions.getExtension('Dart-Code.dart-code');
      if (!dartExt) {
        return false;
      }
      if (!dartExt.isActive) {
        await dartExt.activate();
      }
      const dtdUri: string | undefined = dartExt.exports?.dtdUri;
      if (!dtdUri) {
        return false;
      }

      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'Editor.selectDevice',
        params: { deviceId },
      });

      await this.sendWsSingleRpc(dtdUri, payload, 1500);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Opens the IDE's native device / emulator picker (`flutter.selectDevice`) so users can
   * also launch offline Android Emulators / iOS Simulators or desktop/web targets in 1 click.
   */
  public async openIdeDevicePicker(): Promise<string | undefined> {
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (cmds.includes('flutter.selectDevice')) {
        await vscode.commands.executeCommand('flutter.selectDevice');
        return await this.getIdeSelectedDeviceId();
      }
      if (cmds.includes('flutter.launchEmulator')) {
        await vscode.commands.executeCommand('flutter.launchEmulator');
        return await this.getIdeSelectedDeviceId();
      }
      await vscode.commands.executeCommand('workbench.action.debug.selectandstart');
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Starts Run or Debug for the selected launch configuration on the target device,
   * with `suppressDebugView: true` so the sidebar never jumps away from Device Screenshot.
   */
  public async startLaunch(options: {
    selectedKey?: string;
    targetDeviceId?: string;
    availableDevices: MobileDevice[];
    noDebug: boolean;
    pickDevicePlaceholder?: string;
  }): Promise<{ launched: boolean; chosenDeviceId?: string }> {
    const { items, rawMap } = this.getLaunchConfigs();
    const key = options.selectedKey && rawMap.has(options.selectedKey)
      ? options.selectedKey
      : this.getSelectedKey(items);

    if (key !== DEFAULT_LAUNCH_KEY) {
      await this._context.workspaceState.update(SELECTED_LAUNCH_KEY_STATE, key);
    }

    let chosenDeviceId = options.targetDeviceId?.trim() || undefined;

    if (!chosenDeviceId) {
      if (options.availableDevices.length === 1) {
        chosenDeviceId = options.availableDevices[0].id;
      } else if (options.availableDevices.length > 1) {
        const ideDevId = await this.getIdeSelectedDeviceId();
        if (ideDevId) {
          const matched = options.availableDevices.find(
            (d) => d.id.toLowerCase() === ideDevId.toLowerCase()
          );
          chosenDeviceId = matched?.id || ideDevId;
        }
        if (!chosenDeviceId) {
          const picked = await vscode.window.showQuickPick(
            options.availableDevices.map((d) => ({
              label: `${d.reality === 'physical' ? '$(device-mobile)' : '$(vm)'} ${d.name}`,
              description: `${d.platform === 'android' ? 'Android' : 'iOS'} · ${
                d.reality === 'physical' ? (d.transport === 'wifi' ? 'Wi-Fi' : 'USB') : 'Sim'
              } · ${d.id}`,
              device: d,
            })),
            {
              placeHolder: options.pickDevicePlaceholder || 'Select a device to run on',
            }
          );
          if (!picked) {
            return { launched: false };
          }
          chosenDeviceId = picked.device.id;
        }
      }
    }

    if (chosenDeviceId) {
      void this.syncIdeSelectedDeviceById(chosenDeviceId);
    }

    const sessionOptions: vscode.DebugSessionOptions = {
      noDebug: options.noDebug,
      suppressDebugView: true,
    };

    const defaultFolder = vscode.workspace.workspaceFolders?.[0];
    const entry = rawMap.get(key);

    if (entry?.compoundName) {
      const ok = await vscode.debug.startDebugging(
        entry.folder ?? defaultFolder,
        entry.compoundName,
        sessionOptions
      );
      return { launched: ok, chosenDeviceId };
    }

    if (entry?.config) {
      const cfg: vscode.DebugConfiguration = { ...entry.config };
      if (options.noDebug) {
        cfg.noDebug = true;
      }
      if (chosenDeviceId && (!cfg.type || cfg.type === 'dart')) {
        const fixedDesktopTargets = ['chrome', 'web-server', 'macos', 'windows', 'linux', 'flutter-tester'];
        const existingDevId = typeof cfg.deviceId === 'string' ? cfg.deviceId.toLowerCase() : '';
        if (!existingDevId || !fixedDesktopTargets.includes(existingDevId)) {
          cfg.deviceId = chosenDeviceId;
        }
      }
      const ok = await vscode.debug.startDebugging(entry.folder ?? defaultFolder, cfg, sessionOptions);
      return { launched: ok, chosenDeviceId };
    }

    // Fallback when workspace has no .vscode/launch.json configurations
    const dartExt = vscode.extensions.getExtension('Dart-Code.dart-code');
    if (dartExt && defaultFolder) {
      const fallbackCfg: vscode.DebugConfiguration = {
        name: 'Flutter',
        request: 'launch',
        type: 'dart',
        noDebug: options.noDebug,
      };
      if (chosenDeviceId) {
        fallbackCfg.deviceId = chosenDeviceId;
      }
      const ok = await vscode.debug.startDebugging(defaultFolder, fallbackCfg, sessionOptions);
      return { launched: ok, chosenDeviceId };
    }

    await vscode.commands.executeCommand(
      options.noDebug ? 'workbench.action.debug.run' : 'workbench.action.debug.start'
    );
    return { launched: true, chosenDeviceId };
  }

  public async hotReload(): Promise<void> {
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (this.getState().isFlutterOrDart) {
        if (cmds.includes('_dart.hotReload.withSave')) {
          await vscode.commands.executeCommand('_dart.hotReload.withSave');
          return;
        }
        if (cmds.includes('flutter.hotReload')) {
          await Promise.race([
            vscode.workspace.saveAll(false),
            new Promise((r) => setTimeout(r, 150)),
          ]);
          await vscode.commands.executeCommand('flutter.hotReload');
          return;
        }
      }
      await vscode.commands.executeCommand('workbench.action.debug.restart');
    } catch {
      // ignore
    }
  }

  public async hotRestart(): Promise<void> {
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (this.getState().isFlutterOrDart && cmds.includes('flutter.hotRestart')) {
        await Promise.race([
          vscode.workspace.saveAll(false),
          new Promise((r) => setTimeout(r, 150)),
        ]);
        await vscode.commands.executeCommand('flutter.hotRestart');
        return;
      }
      await vscode.commands.executeCommand('workbench.action.debug.restart');
    } catch {
      // ignore
    }
  }

  public async stopDebug(preferredDeviceId?: string): Promise<void> {
    try {
      if (preferredDeviceId) {
        for (const s of this._activeSessions.values()) {
          if (s.configuration?.deviceId === preferredDeviceId) {
            await vscode.debug.stopDebugging(s);
            return;
          }
        }
      }
      if (vscode.debug.activeDebugSession) {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
        return;
      }
      const first = this._activeSessions.values().next().value;
      if (first) {
        await vscode.debug.stopDebugging(first);
        return;
      }
      await vscode.commands.executeCommand('workbench.action.debug.stop');
    } catch {
      // ignore
    }
  }

  /**
   * Minimal RFC-6455 WebSocket client over built-in Node `http` so DTD RPC works across
   * all Node / Electron versions without external `ws` dependencies.
   */
  private sendWsSingleRpc(wsUri: string, jsonText: string, timeoutMs = 1500): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        const parsed = new URL(wsUri);
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
          hostname: parsed.hostname || '127.0.0.1',
          port: parsed.port,
          path: (parsed.pathname || '/') + (parsed.search || ''),
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Version': '13',
          },
        });

        const timer = setTimeout(() => {
          req.destroy();
          finish();
        }, timeoutMs);

        req.on('upgrade', (_res, socket) => {
          const payload = Buffer.from(jsonText, 'utf8');
          const mask = crypto.randomBytes(4);
          let header: Buffer;
          if (payload.length < 126) {
            header = Buffer.from([0x81, 0x80 | payload.length]);
          } else {
            header = Buffer.from([
              0x81,
              0x80 | 126,
              (payload.length >> 8) & 0xff,
              payload.length & 0xff,
            ]);
          }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) {
            masked[i] = payload[i] ^ mask[i % 4];
          }
          socket.write(Buffer.concat([header, mask, masked]));

          socket.once('data', () => {
            clearTimeout(timer);
            socket.destroy();
            finish();
          });
          socket.once('error', () => {
            clearTimeout(timer);
            finish();
          });
          socket.once('close', () => {
            clearTimeout(timer);
            finish();
          });
        });

        req.on('error', () => {
          clearTimeout(timer);
          finish();
        });

        req.end();
      } catch {
        finish();
      }
    });
  }
}
