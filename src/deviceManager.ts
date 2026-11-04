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
  name: string;
  model: string;
  platform: DevicePlatform;
  reality: DeviceReality;
  osVersion?: string;
  transport?: DeviceTransport;
}

export class DeviceManager {
  private _cachedDevicesFingerprint = '';
  private _pollTimer?: NodeJS.Timeout;
  private _listenerCount = 0;
  private _isPolling = false;
  private _androidModelCache = new Map<string, string>();
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

        let model = this._androidModelCache.get(serial) || '';
        if (!model) {
          for (const part of parts.slice(2)) {
            if (part.startsWith('model:')) {
              model = part.replace('model:', '').replace(/_/g, '-');
            }
          }

          try {
            const propRes = await this.execPromise(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model'], 2500);
            const propModel = propRes.stdout.trim();
            if (propModel) {
              model = propModel;
            }
          } catch {
            // Ignore getprop failure and keep parsed model
          }

          if (!model) {
            model = serial;
          }
          this._androidModelCache.set(serial, model);
        }

        devices.push({
          id: serial,
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

  private async listIosPhysicalDevices(): Promise<MobileDevice[]> {
    if (process.platform !== 'darwin') {
      return [];
    }

    const devices: MobileDevice[] = [];
    const seenUdids = new Set<string>();

    // 1. Try Xcode CoreDevice (xcrun devicectl) - supports iOS 17+ / Xcode 15+
    try {
      const { stdout } = await this.execPromise('xcrun', ['devicectl', 'list', 'devices', '-j', '-'], 6000);
      const parsed = JSON.parse(stdout);
      const rawDevices: any[] = parsed?.result?.devices || [];

      for (const d of rawDevices) {
        const reality = d?.properties?.hardware?.reality || d?.hardwareProperties?.reality;
        if (reality !== 'physical') {
          continue;
        }

        const connState = d?.properties?.connection?.state || d?.connectionProperties?.tunnelState;
        const pairingState = d?.properties?.connection?.pairingState || d?.connectionProperties?.pairingState;
        // Skip devices that are explicitly unavailable/disconnected
        if (connState === 'unavailable' || connState === 'disconnected') {
          continue;
        }
        if (connState !== 'connected' && pairingState !== 'paired') {
          continue;
        }

        const udid = d?.properties?.hardware?.udid || d?.hardwareProperties?.udid || d?.identifier;
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

        const rawTransport = String(
          d?.properties?.connection?.transportType ||
          d?.connectionProperties?.transportType ||
          ''
        ).toLowerCase();

        let transport: DeviceTransport = 'usb';
        if (rawTransport.includes('network') || rawTransport.includes('wifi') || rawTransport.includes('localnetwork')) {
          transport = 'wifi';
        } else if (rawTransport.includes('wired') || rawTransport.includes('usb')) {
          transport = 'usb';
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
