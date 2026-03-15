const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  let win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#0d0d1a'
  });

  try { win.setIcon(__dirname + '/site/icon.png'); } catch(e) {}
  win.loadFile('site/index.html');
  win.setMenu(null);
}

app.on('ready', createWindow);

const IMAGE_EXTS = new Set([
  '.nef', '.png', '.jpg', '.jpeg', '.webp',
  '.tiff', '.tif', '.bmp', '.gif', '.heic',
  '.cr2', '.cr3', '.arw', '.dng', '.raf', '.orf', '.rw2'
]);

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Photo Folder'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('scan-folder', async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      .map(e => ({
        name: e.name,
        path: path.join(folderPath, e.name),
        ext: path.extname(e.name).toLowerCase()
      }));
  } catch (err) {
    return [];
  }
});

ipcMain.handle('move-file', async (event, filePath, category) => {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  const destDir = path.join(dir, category);
  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const destPath = path.join(destDir, filename);
    fs.renameSync(filePath, destPath);
    return { success: true, destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-data', async (event, folderPath, data) => {
  try {
    const dataPath = path.join(folderPath, 'photo-sorter-data.json');
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

ipcMain.handle('load-data', async (event, folderPath) => {
  try {
    const dataPath = path.join(folderPath, 'photo-sorter-data.json');
    if (fs.existsSync(dataPath)) {
      return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    }
    return null;
  } catch (err) {
    return null;
  }
});
