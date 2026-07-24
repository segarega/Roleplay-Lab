import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type ChatEvent,
  type RpCompareApi
} from '../shared/types'

const api: RpCompareApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
    onBeforeClose: (listener) => {
      const wrapped = (): void => listener()
      ipcRenderer.on(IPC_CHANNELS.appBeforeClose, wrapped)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appBeforeClose, wrapped)
    },
    readyToClose: (saved) => ipcRenderer.send(IPC_CHANNELS.appCloseReady, saved)
  },
  credentials: {
    save: (request) => ipcRenderer.invoke(IPC_CHANNELS.credentialSave, request),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.credentialDelete, request),
    status: (request) => ipcRenderer.invoke(IPC_CHANNELS.credentialStatus, request)
  },
  workspace: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceLoad),
    save: (workspace) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSave, workspace),
    import: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceImport),
    export: (workspace) => ipcRenderer.invoke(IPC_CHANNELS.workspaceExport, workspace)
  },
  models: {
    list: (connection) => ipcRenderer.invoke(IPC_CHANNELS.modelsList, connection)
  },
  chat: {
    start: (request) => ipcRenderer.invoke(IPC_CHANNELS.chatStart, request),
    cancel: (request) => ipcRenderer.invoke(IPC_CHANNELS.chatCancel, request),
    onEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent): void => {
        listener(chatEvent)
      }
      ipcRenderer.on(IPC_CHANNELS.chatEvent, wrapped)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, wrapped)
    }
  },
  files: {
    importText: (request) => ipcRenderer.invoke(IPC_CHANNELS.fileImport, request),
    exportReport: (request) => ipcRenderer.invoke(IPC_CHANNELS.reportExport, request)
  },
  logs: {
    setEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.logsSetEnabled, enabled),
    reveal: () => ipcRenderer.invoke(IPC_CHANNELS.logsReveal)
  }
}

contextBridge.exposeInMainWorld('rpCompare', Object.freeze(api))
