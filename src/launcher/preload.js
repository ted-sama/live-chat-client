const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('liveChat', {
    platform: process.platform,
    getState: () => ipcRenderer.invoke('launcher:state'),
    search: (query) => ipcRenderer.invoke('launcher:search', query),
    send: (id, options) => ipcRenderer.invoke('launcher:send', id, options),
    reveal: (id) => ipcRenderer.invoke('launcher:reveal', id),
    addFolder: () => ipcRenderer.invoke('launcher:add-folder'),
    openSettings: () => ipcRenderer.invoke('launcher:open-settings'),
    hide: () => ipcRenderer.invoke('launcher:hide'),
    onShown: (callback) => subscribe('launcher:shown', callback),
    onStateChange: (callback) => subscribe('launcher:state-changed', callback),
});
