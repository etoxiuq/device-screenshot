import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type DevicePlatform = 'android' | 'ios';
export type DeviceReality = 'physical' | 'simulator';
export type DeviceTransport = 'usb' | 'wifi' | 'simulator';

export interface MobileDevice {
  id: string;
  udid?: string;
  avdId?: string;
  name: string;
  model: string;
  platform: DevicePlatform;
  reality: DeviceReality;
  osVersion?: string;
  transport?: DeviceTransport;
}

export interface OfflineEmulator {
  id: string; // e.g. 'offline:ios:apple_ios_simulator' | 'offline:android:Pixel_10_Pro_XL' | 'offline:android-cold:Pixel_10_Pro_XL'
  emulatorId: string;
  name: string;
  platform: DevicePlatform;
  coldBoot?: boolean;
}

export class DeviceManager {
  private _cachedDevicesFingerprint = '';
  private _pollTimer?: NodeJS.Timeout;
  private _listenerCount = 0;
  private _isPolling = false;
  private _androidModelCache = new Map<string, string>();
  private _androidAvdCache = new Map<string, string>();
  private _bootPromises = new Map<string, Promise<MobileDevice | undefined>>();
  private _hasXcodeSimulatorCache?: boolean;
  private _onDidChangeDevices = new vscode.EventEmitter<MobileDevice[]>();
  public readonly onDidChangeDevices: vscode.Event<MobileDevice[]> = this._onDidChangeDevices.event;

  private getFingerprint(devices: MobileDevice[]): string {
    return devices
      .map((d) => `${d.id}|${d.transport}|${d.reality}|${d.name}`)
      .sort()
      .join(';;');
  }

  public startWatching(intervalMs = 1500): vscode.Disposable {
    this._listenerCount++;
    if (this._listenerCount === 1) {
      this._pollTimer = setInterval(async () => {
        await this.checkDevicesChange();
      }, intervalMs);
    }

    return new vscode.Disposable(() => {
      this._listenerCount = Math.max(0, this._listenerCount - 1);
      if (this._listenerCount === 0 && this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = undefined;
      }
    });
  }

  private async checkDevicesChange(): Promise<void> {
    if (this._isPolling) {
      return;
    }
    this._isPolling = true;
    try {
      const prevFingerprint = this._cachedDevicesFingerprint;
      const devices = await this.listDevices(false);
      const newFingerprint = this.getFingerprint(devices);

      if (newFingerprint !== prevFingerprint) {
        this._cachedDevicesFingerprint = newFingerprint;
        this._onDidChangeDevices.fire(devices);
      }
    } catch {
      // ignore poll error
    } finally {
      this._isPolling = false;
    }
  }
  private getEnvWithPaths(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const extraPaths = [
      path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'),
      path.join(home, 'Android', 'Sdk', 'platform-tools'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
    const currentPath = process.env.PATH || '';
    return {
      ...process.env,
      PATH: [...extraPaths, currentPath].join(path.delimiter),
    };
  }

  private getEmulatorCommand(): string {
    const exeName = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
    const config = vscode.workspace.getConfiguration('deviceScreenshot');
    const customAdb = config.get<string>('adbPath', '').trim();
    const fromCustomAdb = customAdb
      ? path.resolve(path.dirname(customAdb), '..', 'emulator', exeName)
      : '';

    const home = os.homedir();
    const candidates = [
      fromCustomAdb,
      process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'emulator', exeName) : '',
      process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'emulator', exeName) : '',
      path.join(home, 'Library', 'Android', 'sdk', 'emulator', exeName),
      path.join(home, 'Android', 'Sdk', 'emulator', exeName),
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'emulator', exeName)
        : '',
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return exeName;
  }

  private readAndroidAvdDisplayName(avdDir: string, avdId: string): string {
    try {
      const cfgPath = path.join(avdDir, `${avdId}.avd`, 'config.ini');
      if (fs.existsSync(cfgPath)) {
        const content = fs.readFileSync(cfgPath, 'utf8');
        const match = /^avd\.ini\.displayname\s*=\s*(.+)$/m.exec(content);
        if (match && match[1].trim()) {
          return match[1].trim();
        }
      }
    } catch {
      // ignore
    }
    return avdId.replace(/_/g, ' ');
  }

  private async listInstalledAndroidAvds(): Promise<Array<{ id: string; name: string }>> {
    const avdDir = path.join(os.homedir(), '.android', 'avd');
    const results: Array<{ id: string; name: string }> = [];
    try {
      if (!fs.existsSync(avdDir)) {
        return results;
      }
      const entries = await fs.promises.readdir(avdDir);
      for (const entry of entries) {
        if (!entry.endsWith('.ini')) {
          continue;
        }
        const avdId = entry.slice(0, -4);
        if (!avdId) {
          continue;
        }
        results.push({
          id: avdId,
          name: this.readAndroidAvdDisplayName(avdDir, avdId),
        });
      }
      results.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // ignore
    }
    return results;
  }

  private hasXcodeSimulator(): boolean {
    if (process.platform !== 'darwin') {
      return false;
    }
    if (this._hasXcodeSimulatorCache !== undefined) {
      return this._hasXcodeSimulatorCache;
    }
    this._hasXcodeSimulatorCache =
      fs.existsSync('/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app') ||
      fs.existsSync('/Library/Developer/CommandLineTools');
    return this._hasXcodeSimulatorCache;
  }

  public async listOfflineEmulators(connectedDevices: MobileDevice[]): Promise<OfflineEmulator[]> {
    const offline: OfflineEmulator[] = [];

    // 1. iOS Simulator (macOS) - show 'Start iOS Simulator' when none is currently booted
    if (process.platform === 'darwin' && this.hasXcodeSimulator()) {
      const hasBootedIosSim = connectedDevices.some(
        (d) => d.platform === 'ios' && d.reality === 'simulator'
      );
      if (!hasBootedIosSim) {
        offline.push({
          id: 'offline:ios:apple_ios_simulator',
          emulatorId: 'apple_ios_simulator',
          name: 'iOS Simulator',
          platform: 'ios',
          coldBoot: false,
        });
      }
    }

    // 2. Android Offline Emulators (AVDs not currently booted)
    const bootedAvdIds = new Set(
      connectedDevices
        .filter((d) => d.platform === 'android' && d.reality === 'simulator' && d.avdId)
        .map((d) => d.avdId as string)
    );
    const avds = await this.listInstalledAndroidAvds();
    for (const avd of avds) {
      if (bootedAvdIds.has(avd.id)) {
        continue;
      }
      offline.push({
        id: `offline:android:${avd.id}`,
        emulatorId: avd.id,
        name: avd.name,
        platform: 'android',
        coldBoot: false,
      });
      offline.push({
        id: `offline:android-cold:${avd.id}`,
        emulatorId: avd.id,
        name: avd.name,
        platform: 'android',
        coldBoot: true,
      });
    }

    return offline;
  }

  public async bootOfflineEmulator(specId: string, progressTitle?: string): Promise<MobileDevice | undefined> {
    if (!specId.startsWith('offline:')) {
      return undefined;
    }
    const parts = specId.split(':');
    const kind = parts[1]; // 'ios' | 'android' | 'android-cold'
    const emulatorId = parts.slice(2).join(':');
    const dedupeKey = `${kind === 'android-cold' ? 'android' : kind}:${emulatorId}`;

    const existing = this._bootPromises.get(dedupeKey);
    if (existing) {
      return existing;
    }

    const friendlyLabel =
      kind === 'ios'
        ? 'iOS Simulator'
        : this.readAndroidAvdDisplayName(path.join(os.homedir(), '.android', 'avd'), emulatorId);

    const task = vscode.window.withProgress<MobileDevice | undefined>(
      {
        location: vscode.ProgressLocation.Notification,
        title: progressTitle || `Starting ${friendlyLabel}...`,
        cancellable: true,
      },
      async (_progress, token) => {
        if (kind === 'ios') {
          try {
            await this.execPromise('open', ['-a', 'Simulator'], 5000);
          } catch {
            // ignore
          }

          let fallbackBootAttempted = false;
          for (let i = 0; i < 45; i++) {
            if (token.isCancellationRequested) {
              return undefined;
            }
            const sims = await this.listIosSimulators();
            if (sims.length > 0) {
              return sims[0];
            }
            // If Simulator.app opened without auto-booting any device after ~3.5s, boot best available iPhone
            if (i === 4 && !fallbackBootAttempted) {
              fallbackBootAttempted = true;
              const bestUdid = await this.findPreferredIosSimulatorUdid();
              if (bestUdid) {
                await this.execPromise('xcrun', ['simctl', 'boot', bestUdid], 8000).catch(() => {});
                await this.execPromise('open', ['-a', 'Simulator'], 5000).catch(() => {});
              }
            }
            await new Promise((r) => setTimeout(r, 800));
          }
          return undefined;
        }

        // Android AVD boot
        const emulatorBin = this.getEmulatorCommand();
        const coldBoot = kind === 'android-cold';
        const args = coldBoot ? ['-avd', emulatorId, '-no-snapshot-load'] : ['-avd', emulatorId];
        try {
          const child = cp.spawn(emulatorBin, args, {
            detached: true,
            stdio: 'ignore',
            env: this.getEnvWithPaths(),
          });
          child.unref();
        } catch {
          return undefined;
        }

        const adb = this.getAdbCommand();
        for (let i = 0; i < 90; i++) {
          if (token.isCancellationRequested) {
            return undefined;
          }
          await new Promise((r) => setTimeout(r, 1000));
          const androidList = await this.listAndroidDevices();
          const matched =
            androidList.find((d) => d.avdId === emulatorId) ||
            androidList.find((d) => d.reality === 'simulator');
          if (matched) {
            try {
              const bootRes = await this.execPromise(
                adb,
                ['-s', matched.id, 'shell', 'getprop', 'sys.boot_completed'],
                2500
              );
              if (bootRes.stdout.trim() === '1') {
                return matched;
              }
            } catch {
              // still booting
            }
          }
        }
        return undefined;
      }
    );

    const wrapped = Promise.resolve(task).finally(() => {
      this._bootPromises.delete(dedupeKey);
    });
    this._bootPromises.set(dedupeKey, wrapped);
    return wrapped;
  }

  private async findPreferredIosSimulatorUdid(): Promise<string | undefined> {
    try {
      const { stdout } = await this.execPromise('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], 5000);
      const parsed = JSON.parse(stdout);
      const devicesMap = parsed?.devices || {};
      const candidates: Array<{ udid: string; name: string; lastUsedAt?: string }> = [];

      for (const runtime of Object.keys(devicesMap)) {
        if (!runtime.toLowerCase().includes('ios')) {
          continue;
        }
        for (const sim of devicesMap[runtime] || []) {
          if (sim?.isAvailable && sim?.udid) {
            candidates.push({
              udid: sim.udid,
              name: String(sim.name || ''),
              lastUsedAt: typeof sim.lastUsedAt === 'string' ? sim.lastUsedAt : undefined,
            });
          }
        }
      }

      const withLastUsed = candidates
        .filter((c) => c.lastUsedAt)
        .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
      if (withLastUsed.length > 0) {
        return withLastUsed[0].udid;
      }

      const iphone = candidates.find((c) => c.name.toLowerCase().includes('iphone'));
      return iphone?.udid || candidates[0]?.udid;
    } catch {
      return undefined;
    }
  }

  private getAdbCommand(): string {
    const config = vscode.workspace.getConfiguration('deviceScreenshot');
    const customAdb = config.get<string>('adbPath', '').trim();
    if (customAdb && fs.existsSync(customAdb)) {
      return customAdb;
    }

    const home = os.homedir();
    const candidates = [
      process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : '',
      process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : '',
      path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
      path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return 'adb';
  }

  private execPromise(cmd: string, args: string[], timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      cp.execFile(
        cmd,
        args,
        {
          env: this.getEnvWithPaths(),
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr?.trim() || err.message));
          } else {
            resolve({ stdout, stderr });
          }
        }
      );
    });
  }

  private execBufferPromise(cmd: string, args: string[], timeoutMs = 15000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      cp.execFile(
        cmd,
        args,
        {
          env: this.getEnvWithPaths(),
          encoding: 'buffer',
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const errMsg = stderr ? stderr.toString('utf8').trim() : err.message;
            reject(new Error(errMsg || err.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  public async listDevices(updateCache = true): Promise<MobileDevice[]> {
    const [androidDevices, iosPhysicalDevices, iosSimulators] = await Promise.all([
      this.listAndroidDevices(),
      this.listIosPhysicalDevices(),
      this.listIosSimulators(),
    ]);

    const all = [...androidDevices, ...iosPhysicalDevices, ...iosSimulators];

    // Sort: Physical devices first, then simulators/emulators
    all.sort((a, b) => {
      if (a.reality !== b.reality) {
        return a.reality === 'physical' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    if (updateCache) {
      this._cachedDevicesFingerprint = this.getFingerprint(all);
    }

    return all;
  }

  private async listAndroidDevices(): Promise<MobileDevice[]> {
    const adb = this.getAdbCommand();
    try {
      const { stdout } = await this.execPromise(adb, ['devices', '-l'], 5000);
      const lines = stdout.split(/\r?\n/).slice(1);
      const devices: MobileDevice[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parts = trimmed.split(/\s+/);
        const serial = parts[0];
        const state = parts[1];
        if (state !== 'device') {
          continue;
        }

        const isEmulator = serial.startsWith('emulator-');
        const isWifi = /:\d+$/.test(serial) || (!isEmulator && !trimmed.includes('usb:'));
        const transport: DeviceTransport = isEmulator ? 'simulator' : isWifi ? 'wifi' : 'usb';

        let avdId: string | undefined;
        if (isEmulator) {
          avdId = this._androidAvdCache.get(serial);
          if (!avdId) {
            try {
              const avdRes = await this.execPromise(
                adb,
                ['-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'],
                2500
              );
              const parsedAvd = avdRes.stdout.trim();
              if (parsedAvd) {
                avdId = parsedAvd;
                this._androidAvdCache.set(serial, parsedAvd);
              }
            } catch {
              // ignore
            }
          }
        }

        let model = this._androidModelCache.get(serial) || '';
        if (!model) {
          if (isEmulator && avdId) {
            model = this.readAndroidAvdDisplayName(path.join(os.homedir(), '.android', 'avd'), avdId);
          }
          if (!model) {
            for (const part of parts.slice(2)) {
              if (part.startsWith('model:')) {
                model = part.replace('model:', '').replace(/_/g, '-');
              }
            }
          }

          if (!isEmulator) {
            try {
              const propRes = await this.execPromise(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model'], 2500);
              const propModel = propRes.stdout.trim();
              if (propModel) {
                model = propModel;
              }
            } catch {
              // Ignore getprop failure and keep parsed model
            }
          }

          if (!model) {
            model = serial;
          }
          this._androidModelCache.set(serial, model);
        }

        devices.push({
          id: serial,
          avdId,
          name: model,
          model,
          platform: 'android',
          reality: isEmulator ? 'simulator' : 'physical',
          transport,
        });
      }

      return devices;
    } catch {
      return [];
    }
  }

  private async getMacUsbSerials(): Promise<Set<string>> {
    const serials = new Set<string>();
    if (process.platform !== 'darwin') {
      return serials;
    }
    try {
      const { stdout } = await this.execPromise('ioreg', ['-p', 'IOUSB', '-w0', '-l'], 2500);
      const regex = /"USB Serial Number"\s*=\s*"([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stdout)) !== null) {
        serials.add(match[1].replace(/-/g, '').toUpperCase());
      }
    } catch {
      // ignore ioreg failure
    }
    return serials;
  }

  private async listIosPhysicalDevices(): Promise<MobileDevice[]> {
    if (process.platform !== 'darwin') {
      return [];
    }

    const devices: MobileDevice[] = [];
    const seenUdids = new Set<string>();
    const usbSerials = await this.getMacUsbSerials();

    // 1. Try Xcode CoreDevice (xcrun devicectl) - supports iOS 17+ / Xcode 15+
    try {
      const { stdout } = await this.execPromise('xcrun', ['devicectl', 'list', 'devices', '-j', '-'], 6000);
      const jsonIdx = stdout.indexOf('{');
      const parsed = JSON.parse(jsonIdx >= 0 ? stdout.slice(jsonIdx) : stdout);
      const rawDevices: any[] = parsed?.result?.devices || [];

      for (const d of rawDevices) {
        const reality = d?.properties?.hardware?.reality || d?.hardwareProperties?.reality;
        if (reality !== 'physical') {
          continue;
        }

        const udid = d?.properties?.hardware?.udid || d?.hardwareProperties?.udid || d?.identifier;
        const normalizedUdid = udid ? String(udid).replace(/-/g, '').toUpperCase() : '';
        const isPhysicallyOnUsb = normalizedUdid.length > 0 && usbSerials.has(normalizedUdid);

        const connState = d?.properties?.connection?.state || d?.connectionProperties?.tunnelState;
        const pairingState = d?.properties?.connection?.pairingState || d?.connectionProperties?.pairingState;
        const rawTransport = String(
          d?.properties?.connection?.transportType ||
          d?.connectionProperties?.transportType ||
          ''
        ).toLowerCase();

        // In CoreDevice, 'unavailable' means unplugged & unreachable.
        // 'disconnected' means the on-demand DDI tunnel is idle while the device itself is
        // 'available (paired)' when transportType ('wired' / 'localNetwork') is present.
        const isActivelyConnected = connState === 'connected' || connState === 'connecting';
        const isAvailablePaired =
          connState !== 'unavailable' && pairingState === 'paired' && rawTransport.length > 0;

        if (!isActivelyConnected && !isAvailablePaired && !isPhysicallyOnUsb) {
          continue;
        }

        const identifier = d?.identifier || udid;
        const name = d?.properties?.state?.name || d?.deviceProperties?.name || 'iPhone';
        const marketingName =
          d?.properties?.hardware?.marketingName ||
          d?.hardwareProperties?.marketingName ||
          d?.properties?.hardware?.productType ||
          'iOS Device';
        const osVer =
          d?.properties?.software?.osVersionNumber?.stringValue ||
          d?.deviceProperties?.osVersionNumber ||
          '';

        if (udid) {
          seenUdids.add(udid);
        }

        let transport: DeviceTransport = 'usb';
        if (isPhysicallyOnUsb || rawTransport.includes('wired') || rawTransport.includes('usb')) {
          transport = 'usb';
        } else if (rawTransport.includes('network') || rawTransport.includes('wifi') || rawTransport.includes('localnetwork')) {
          transport = 'wifi';
        }

        devices.push({
          id: udid || identifier,
          udid,
          name: `${name} (${marketingName})`,
          model: marketingName,
          platform: 'ios',
          reality: 'physical',
          osVersion: osVer,
          transport,
        });
      }
    } catch {
      // devicectl not available or failed
    }

    // 2. Fallback: libimobiledevice (idevice_id -l) for older iOS or non-CoreDevice setups
    try {
      const { stdout } = await this.execPromise('idevice_id', ['-l'], 3000);
      const udids = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const udid of udids) {
        if (seenUdids.has(udid)) {
          continue;
        }
        let deviceName = 'iPhone';
        try {
          const nameRes = await this.execPromise('idevicename', ['-u', udid], 2500);
          if (nameRes.stdout.trim()) {
            deviceName = nameRes.stdout.trim();
          }
        } catch {
          // ignore
        }
        devices.push({
          id: udid,
          udid,
          name: deviceName,
          model: 'iOS Device',
          platform: 'ios',
          reality: 'physical',
          transport: 'usb',
        });
      }
    } catch {
      // idevice_id not installed
    }

    return devices;
  }

  private async listIosSimulators(): Promise<MobileDevice[]> {
    if (process.platform !== 'darwin') {
      return [];
    }

    try {
      const { stdout } = await this.execPromise('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], 4000);
      const parsed = JSON.parse(stdout);
      const devicesMap = parsed?.devices || {};
      const result: MobileDevice[] = [];

      for (const runtime of Object.keys(devicesMap)) {
        const list = devicesMap[runtime] || [];
        for (const sim of list) {
          if (sim.state === 'Booted') {
            result.push({
              id: sim.udid,
              udid: sim.udid,
              name: `${sim.name} (Simulator)`,
              model: sim.name,
              platform: 'ios',
              reality: 'simulator',
              transport: 'simulator',
            });
          }
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  public async captureScreenshot(device: MobileDevice): Promise<Buffer> {
    if (device.platform === 'android') {
      return this.captureAndroid(device);
    } else if (device.reality === 'physical') {
      return this.captureIosPhysical(device);
    } else {
      return this.captureIosSimulator(device);
    }
  }

  private async captureAndroid(device: MobileDevice): Promise<Buffer> {
    const adb = this.getAdbCommand();
    try {
      const buffer = await this.execBufferPromise(adb, ['-s', device.id, 'exec-out', 'screencap', '-p'], 12000);
      // Verify PNG magic header (89 50 4E 47)
      if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return buffer;
      }
      throw new Error('Invalid PNG stream from exec-out');
    } catch {
      // Fallback: capture to /sdcard and pull
      const remotePath = '/sdcard/_vscode_device_screenshot.png';
      const localPath = path.join(os.tmpdir(), `android_cap_${Date.now()}.png`);
      try {
        await this.execPromise(adb, ['-s', device.id, 'shell', 'screencap', '-p', remotePath], 10000);
        await this.execPromise(adb, ['-s', device.id, 'pull', remotePath, localPath], 10000);
        const buf = await fs.promises.readFile(localPath);
        return buf;
      } finally {
        fs.promises.unlink(localPath).catch(() => {});
        this.execPromise(adb, ['-s', device.id, 'shell', 'rm', '-f', remotePath], 3000).catch(() => {});
      }
    }
  }

  private async captureIosPhysical(device: MobileDevice): Promise<Buffer> {
    const tmpFile = path.join(os.tmpdir(), `ios_phys_cap_${Date.now()}.png`);
    try {
      // 1. Try Xcode devicectl first
      try {
        await this.execPromise(
          'xcrun',
          ['devicectl', 'device', 'capture', 'screenshot', '--device', device.id, '--destination', tmpFile],
          15000
        );
        if (fs.existsSync(tmpFile)) {
          return await fs.promises.readFile(tmpFile);
        }
      } catch (devicectlErr: any) {
        // 2. Fallback to idevicescreenshot if installed
        try {
          const args = device.udid ? ['-u', device.udid, tmpFile] : [tmpFile];
          await this.execPromise('idevicescreenshot', args, 12000);
          if (fs.existsSync(tmpFile)) {
            return await fs.promises.readFile(tmpFile);
          }
        } catch {
          throw new Error(
            `iOS 실기기 캡처 실패 (${device.name}): ${devicectlErr?.message || 'Xcode 기기 연결 및 개발자 모드를 확인해주세요.'}`
          );
        }
      }
      throw new Error('스크린샷 파일을 생성하지 못했습니다.');
    } finally {
      fs.promises.unlink(tmpFile).catch(() => {});
    }
  }

  private async captureIosSimulator(device: MobileDevice): Promise<Buffer> {
    const tmpFile = path.join(os.tmpdir(), `ios_sim_cap_${Date.now()}.png`);
    try {
      await this.execPromise('xcrun', ['simctl', 'io', device.id, 'screenshot', tmpFile], 10000);
      return await fs.promises.readFile(tmpFile);
    } finally {
      fs.promises.unlink(tmpFile).catch(() => {});
    }
  }
}
