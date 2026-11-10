import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type PromptTarget = 'copilot' | 'antigravity' | 'fallback';

function execFilePromise(cmd: string, args: string[], timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function viewExpandedScore(viewObj: any): number {
  if (!viewObj || viewObj.collapsed === true) {
    return 0;
  }
  if (typeof viewObj.size === 'number') {
    // Collapsed/squished header-only accordion panes in VS Code are ~22-36px tall
    return viewObj.size <= 40 ? 5 : viewObj.size;
  }
  return 500;
}

function scoreChatContainerViews(rawJson?: string): { copilot: number; antigravity: number } {
  if (!rawJson) {
    return { copilot: 500, antigravity: 0 };
  }
  try {
    const parsed = JSON.parse(rawJson);
    const copilotView = parsed?.['workbench.panel.chat.view.copilot'];
    const agView = parsed?.['antigravity.panel'];

    const copilot = copilotView !== undefined ? viewExpandedScore(copilotView) : 500;
    const antigravity = agView !== undefined ? viewExpandedScore(agView) : 0;
    return { copilot, antigravity };
  } catch {
    return { copilot: 500, antigravity: 0 };
  }
}

export function evaluateWorkspaceStateMap(
  map: Record<string, string>,
  appName: string
): 'copilot' | 'antigravity' {
  let copilotScore = 0;
  let antigravityScore = 0;

  // 1. Check Right Secondary Side Bar (Auxiliary Bar)
  if (map['workbench.auxiliaryBar.hidden'] !== 'true') {
    const activeAuxId = map['workbench.auxiliarybar.activepanelid'] || '';
    let auxContainers: Array<{ id?: string; visible?: boolean }> = [];
    try {
      auxContainers = JSON.parse(map['workbench.auxiliarybar.viewContainersWorkspaceState'] || '[]');
    } catch {
      auxContainers = [];
    }

    if (activeAuxId.includes('antigravity')) {
      try {
        const agIdeState = JSON.parse(map['antigravity.agentViewContainerId.state'] || '{}');
        const panelScore = viewExpandedScore(agIdeState?.['antigravity.agentSidePanel']);
        antigravityScore += panelScore > 0 ? panelScore : 600;
      } catch {
        antigravityScore += 600;
      }
    } else {
      const isChatInAux =
        activeAuxId === 'workbench.panel.chat' ||
        (!activeAuxId && auxContainers.some((c) => c.id === 'workbench.panel.chat' && c.visible));

      if (isChatInAux) {
        const scores = scoreChatContainerViews(map['workbench.panel.chat']);
        copilotScore += scores.copilot;
        antigravityScore += scores.antigravity;
      }
    }
  }

  // 2. Check Left Primary Side Bar
  if (map['workbench.sideBar.hidden'] !== 'true') {
    const activeSidebarId = map['workbench.sidebar.activeviewletid'] || '';
    if (activeSidebarId.includes('antigravity')) {
      antigravityScore += 600;
    } else if (activeSidebarId === 'workbench.panel.chat') {
      const scores = scoreChatContainerViews(map['workbench.panel.chat']);
      copilotScore += scores.copilot;
      antigravityScore += scores.antigravity;
    }
  }

  // 3. Check Bottom Panel
  if (map['workbench.panel.hidden'] !== 'true') {
    const activePanelId = map['workbench.panel.activepanelid'] || '';
    if (activePanelId.includes('antigravity')) {
      antigravityScore += 600;
    } else if (activePanelId === 'workbench.panel.chat') {
      const scores = scoreChatContainerViews(map['workbench.panel.chat']);
      copilotScore += scores.copilot;
      antigravityScore += scores.antigravity;
    }
  }

  if (copilotScore > antigravityScore) {
    return 'copilot';
  }
  if (antigravityScore > copilotScore) {
    return 'antigravity';
  }

  return appName.toLowerCase().includes('antigravity') ? 'antigravity' : 'copilot';
}

async function readWorkspaceStateMap(context: vscode.ExtensionContext): Promise<Record<string, string> | null> {
  const storageFsPath = context.storageUri?.fsPath;
  if (!storageFsPath) {
    return null;
  }
  const stateDbPath = path.join(path.dirname(storageFsPath), 'state.vscdb');
  if (!fs.existsSync(stateDbPath)) {
    return null;
  }

  const keys = [
    'workbench.auxiliaryBar.hidden',
    'workbench.auxiliarybar.activepanelid',
    'workbench.auxiliarybar.viewContainersWorkspaceState',
    'workbench.sideBar.hidden',
    'workbench.sidebar.activeviewletid',
    'workbench.panel.hidden',
    'workbench.panel.activepanelid',
    'workbench.panel.chat',
    'antigravity.agentViewContainerId.state',
  ];
  const inClause = keys.map((k) => `'${k}'`).join(',');
  const sql = `SELECT key, value FROM ItemTable WHERE key IN (${inClause});`;

  const sqliteCandidates = process.platform === 'darwin' ? ['/usr/bin/sqlite3', 'sqlite3'] : ['sqlite3'];
  for (const bin of sqliteCandidates) {
    try {
      const stdout = await execFilePromise(bin, ['-readonly', '-json', stateDbPath, sql], 1200);
      const rows = JSON.parse(stdout || '[]');
      if (Array.isArray(rows)) {
        const map: Record<string, string> = {};
        for (const r of rows) {
          if (r && typeof r.key === 'string' && typeof r.value === 'string') {
            map[r.key] = r.value;
          }
        }
        return map;
      }
    } catch {
      // try next or fallback
    }
  }
  return null;
}

export async function detectActivePromptTarget(
  context: vscode.ExtensionContext,
  allCommands: string[]
): Promise<'copilot' | 'antigravity'> {
  const hasAntigravity = allCommands.includes('antigravity.addContext');
  const hasCopilot =
    allCommands.includes('workbench.action.chat.open') ||
    allCommands.includes('workbench.action.chat.addToChatAction');

  if (hasAntigravity && !hasCopilot) {
    return 'antigravity';
  }
  if (hasCopilot && !hasAntigravity) {
    return 'copilot';
  }

  // Check if an editor tab itself is currently focused on Chat
  const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  if (activeTab) {
    const viewType = String((activeTab.input as any)?.viewType || '').toLowerCase();
    if (viewType.includes('interactive') || viewType.includes('workbench.panel.chat')) {
      return 'copilot';
    }
  }

  const stateMap = await readWorkspaceStateMap(context);
  if (stateMap) {
    return evaluateWorkspaceStateMap(stateMap, vscode.env.appName || '');
  }

  return (vscode.env.appName || '').toLowerCase().includes('antigravity') ? 'antigravity' : 'copilot';
}

export async function sendImageFileToActivePrompt(
  context: vscode.ExtensionContext,
  filePath: string
): Promise<{ attached: boolean; target: PromptTarget }> {
  const fileUri = vscode.Uri.file(filePath);
  const allCommands = await vscode.commands.getCommands(true);
  const preferred = await detectActivePromptTarget(context, allCommands);

  const tryCopilot = async (): Promise<boolean> => {
    if (allCommands.includes('workbench.action.chat.open')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          attachFiles: [fileUri],
        });
        return true;
      } catch {
        // fallback below
      }
    }
    if (allCommands.includes('workbench.action.chat.addToChatAction')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.addToChatAction', fileUri);
        if (allCommands.includes('workbench.action.chat.focusInput')) {
          await vscode.commands.executeCommand('workbench.action.chat.focusInput');
        }
        return true;
      } catch {
        // fallback below
      }
    }
    return false;
  };

  const tryAntigravity = async (): Promise<boolean> => {
    if (allCommands.includes('antigravity.addContext')) {
      try {
        await vscode.commands.executeCommand('antigravity.addContext', {
          type: 'file',
          uri: fileUri.toString(),
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  if (preferred === 'copilot') {
    if (await tryCopilot()) {
      return { attached: true, target: 'copilot' };
    }
    if (await tryAntigravity()) {
      return { attached: true, target: 'antigravity' };
    }
  } else {
    if (await tryAntigravity()) {
      return { attached: true, target: 'antigravity' };
    }
    if (await tryCopilot()) {
      return { attached: true, target: 'copilot' };
    }
  }

  // Final focus-only fallback (image is already on system clipboard for Cmd+V)
  const focusCommands = [
    'workbench.action.chat.focusInput',
    'workbench.panel.chat.view.copilot.focus',
    'antigravity.panel.focus',
    'antigravity.toggleChatFocus',
  ];
  for (const cmd of focusCommands) {
    if (allCommands.includes(cmd)) {
      try {
        await vscode.commands.executeCommand(cmd);
        break;
      } catch {
        // ignore
      }
    }
  }

  return { attached: false, target: 'fallback' };
}
