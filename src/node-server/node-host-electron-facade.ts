import { EventEmitter } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type NodeHostEnvironment = {
  appPath: string
  dataPath: string
  version: string
}

let environment: NodeHostEnvironment = {
  appPath: dirname(process.argv[1] ?? process.cwd()),
  dataPath: join(homedir(), '.orca-server'),
  version: '0.0.0'
}

export function configureNodeHostEnvironment(next: NodeHostEnvironment): void {
  environment = next
}

class NodeHostApp extends EventEmitter {
  readonly isPackaged = false
  readonly commandLine = {
    appendSwitch: () => {},
    hasSwitch: () => false,
    getSwitchValue: () => ''
  }
  readonly dock = {
    badge: '',
    setBadge: () => {},
    setIcon: () => {},
    show: async () => {},
    hide: async () => {}
  }

  getAppPath(): string {
    return environment.appPath
  }

  getName(): string {
    return 'Orca Server'
  }

  getPath(name: string): string {
    if (name === 'home') {
      return homedir()
    }
    if (name === 'temp') {
      return tmpdir()
    }
    if (name === 'logs') {
      return join(environment.dataPath, 'logs')
    }
    return environment.dataPath
  }

  getVersion(): string {
    return environment.version
  }

  setName(): void {}
  setPath(): void {}
  requestSingleInstanceLock(): boolean {
    return true
  }
  releaseSingleInstanceLock(): void {}
  disableHardwareAcceleration(): void {}
  setAppUserModelId(): void {}
  setAsDefaultProtocolClient(): boolean {
    return false
  }
  removeAsDefaultProtocolClient(): boolean {
    return false
  }
  isDefaultProtocolClient(): boolean {
    return false
  }
  whenReady(): Promise<void> {
    return Promise.resolve()
  }
  quit(): void {
    this.emit('before-quit', { preventDefault: () => {} })
    this.emit('will-quit', { preventDefault: () => {} })
  }
  exit(code = 0): never {
    process.exit(code)
  }
}

class NodeHostIpcMain extends EventEmitter {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, handler)
  }

  handleOnce(channel: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
}

export const app = new NodeHostApp()
export const ipcMain = new NodeHostIpcMain()
export const powerMonitor = new EventEmitter()
export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
export const net = { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }

export class BrowserWindow extends EventEmitter {
  static fromId(): null {
    return null
  }

  static fromWebContents(): null {
    return null
  }

  static getAllWindows(): BrowserWindow[] {
    return []
  }

  static getFocusedWindow(): null {
    return null
  }

  readonly webContents = nodeHostWebContents

  constructor() {
    super()
    throw new Error('Browser windows are unavailable in the Orca npm server')
  }

  isDestroyed(): boolean {
    return true
  }
}

export class BaseWindow extends BrowserWindow {}

export class WebContentsView {
  constructor() {
    throw new Error('Web contents views are unavailable in the Orca npm server')
  }
}

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return false
  }

  show(): void {}
  close(): void {}
}

const nodeHostWebContents = Object.assign(new EventEmitter(), {
  id: -1,
  send: () => {},
  isDestroyed: () => true,
  getURL: () => '',
  openDevTools: () => {},
  closeDevTools: () => {},
  setWindowOpenHandler: () => {},
  session: null
})

export const webContents = {
  fromId: () => undefined,
  getAllWebContents: () => []
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('OS secret encryption is unavailable in the Orca npm server')
  },
  decryptString: () => {
    throw new Error('OS secret encryption is unavailable in the Orca npm server')
  }
}

export const shell = {
  openExternal: async () => {},
  openPath: async () => 'Desktop shell access is unavailable in the Orca npm server',
  showItemInFolder: () => {},
  trashItem: async () => {
    throw new Error('Desktop trash is unavailable in the Orca npm server')
  }
}

export const clipboard = {
  readText: () => '',
  writeText: () => {},
  readImage: () => nativeImage.createEmpty(),
  writeImage: () => {}
}

export const nativeImage = {
  createEmpty: () => ({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
    resize: () => nativeImage.createEmpty(),
    setTemplateImage: () => {}
  }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty()
}

export const dialog = {
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: () => {},
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined })
}

export const Menu = {
  buildFromTemplate: () => ({ popup: () => {}, items: [] }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null
}

export class Tray extends EventEmitter {
  setToolTip(): void {}
  setContextMenu(): void {}
  setImage(): void {}
  destroy(): void {}
}

export const screen = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
  getAllDisplays: () => []
}

export const session = {
  defaultSession: null,
  fromPartition: () => null
}

export const protocol = { registerSchemesAsPrivileged: () => {} }
export const desktopCapturer = { getSources: async () => [] }
export const systemPreferences = new EventEmitter()
export const utilityProcess = {
  fork: () => {
    throw new Error('Electron utility processes are unavailable in the Orca npm server')
  }
}
export const MessageChannelMain = class {
  readonly port1 = new EventEmitter()
  readonly port2 = new EventEmitter()
}
export const globalShortcut = { register: () => false, unregisterAll: () => {} }
export const autoUpdater = new EventEmitter()
