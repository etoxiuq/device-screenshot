import * as vscode from 'vscode';
import { DeviceManager, MobileDevice } from './deviceManager';
import { normalizeLanguage, TRANSLATIONS } from './i18n';
import { LaunchManager } from './launchManager';
import { ScreenshotPanel } from './screenshotPanel';
import { ScreenshotSidebarProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext) {
  const deviceManager = new DeviceManager();
  const launchManager = new LaunchManager(context);
  context.subscriptions.push(launchManager);

  const sidebarProvider = new ScreenshotSidebarProvider(context, deviceManager, launchManager);

  // Register Left Activity Bar Sidebar View
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ScreenshotSidebarProvider.viewType, sidebarProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Status Bar Button (opens the Left Sidebar and triggers capture)
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'deviceScreenshot.capture';
  statusBarItem.text = '$(device-camera) Screenshot';
  statusBarItem.tooltip = 'Open Mobile Device Screenshot (Cmd+Shift+Y)';

  const updateStatusBarVisibility = () => {
    const show = vscode.workspace.getConfiguration('deviceScreenshot').get<boolean>('showStatusBarButton', true);
    if (show) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  };
  updateStatusBarVisibility();

  context.subscriptions.push(
    statusBarItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deviceScreenshot.showStatusBarButton')) {
        updateStatusBarVisibility();
      }
    })
  );

  // Command 1: Focus Left Sidebar (and recapture only if a device is already selected)
  context.subscriptions.push(
    vscode.commands.registerCommand('deviceScreenshot.capture', async () => {
      await vscode.commands.executeCommand(`${ScreenshotSidebarProvider.viewType}.focus`);
      if (sidebarProvider.hasSelectedDevice()) {
        await sidebarProvider.captureSelectedDevice();
      }
    })
  );

  // Command 2: Open Settings Drawer in Left Sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('deviceScreenshot.openSettings', async () => {
      await vscode.commands.executeCommand(`${ScreenshotSidebarProvider.viewType}.focus`);
      sidebarProvider.openSettingsDrawer();
    })
  );

  // Command 3: Open in Large Editor Tab
  context.subscriptions.push(
    vscode.commands.registerCommand('deviceScreenshot.openFullPanel', async () => {
      const devices = await deviceManager.listDevices();
      const lang = normalizeLanguage(
        vscode.workspace.getConfiguration('deviceScreenshot').get<string>('language', 'en')
      );
      const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;

      if (devices.length === 0) {
        vscode.window.showWarningMessage(dict.noDevicesFound.replace(/<br\s*\/?>/gi, ' '));
        return;
      }

      let target: MobileDevice | undefined = devices[0];
      if (devices.length > 1) {
        const items = devices.map((d) => {
          const transportLabel =
            d.reality === 'physical'
              ? (d.transport === 'wifi' ? 'Wi-Fi' : 'USB')
              : (d.platform === 'android' ? 'Emulator' : dict.simulatorBadge);
          return {
            label: `${d.reality === 'physical' ? '$(device-mobile)' : '$(vm)'} ${d.name}`,
            description: `${d.platform === 'android' ? 'Android' : 'iOS'} · ${transportLabel}`,
            device: d,
          };
        });
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: dict.emptyTitle,
        });
        target = picked?.device;
      }

      if (target) {
        await ScreenshotPanel.createOrShow(context, deviceManager, target, devices);
      }
    })
  );
}

export function deactivate() {}
