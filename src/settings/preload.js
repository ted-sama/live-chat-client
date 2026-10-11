const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
    platform: process.platform,
    get: () => ipcRenderer.invoke('settings:get'),
    test: (url) => ipcRenderer.invoke('settings:test', url),
    save: (values) => ipcRenderer.invoke('settings:save', values),
    close: () => ipcRenderer.invoke('settings:close'),
});
