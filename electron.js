const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

const tempFiles = new Set();

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
    const photos = entries
      .filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      .map(e => ({
        name: e.name,
        path: path.join(folderPath, e.name),
        ext: path.extname(e.name).toLowerCase()
      }));

    const CATEGORIES = ['Blurry', 'In-Between', 'Clear'];
    let presorted = 0;
    for (const cat of CATEGORIES) {
      const catDir = path.join(folderPath, cat);
      if (fs.existsSync(catDir)) {
        try {
          const catEntries = fs.readdirSync(catDir, { withFileTypes: true });
          presorted += catEntries.filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())).length;
        } catch (e) {}
      }
    }

    return { photos, presorted };
  } catch (err) {
    return { photos: [], presorted: 0 };
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

const globalDataPath = () => path.join(app.getPath('userData'), 'global-data.json');

ipcMain.handle('save-global-data', async (event, data) => {
  try {
    fs.writeFileSync(globalDataPath(), JSON.stringify(data, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

ipcMain.handle('load-global-data', async () => {
  try {
    const p = globalDataPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    return null;
  } catch (err) {
    return null;
  }
});

// Cache: original file path -> temp jpg path
const previewCache = new Map();

// Valid JPEG marker bytes that can follow FF D8 FF in a real JPEG header
const VALID_JPEG_MARKERS = new Set([
  0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, // APP0-APP7
  0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEE, 0xEF, // APP8-APP15
  0xDB, // DQT (quantization table) — common in camera embedded previews
  0xC0, 0xC1, 0xC2, 0xC3, 0xC4, // SOF0-SOF3 + DHT
  0xFE, // COM
]);

// Scan a file buffer for embedded JPEG blobs (camera RAW files embed JPEG previews in EXIF)
function extractLargestEmbeddedJpeg(buf) {
  const soiMarker = Buffer.from([0xFF, 0xD8, 0xFF]);
  const eoiMarker = Buffer.from([0xFF, 0xD9]);

  // Collect ALL SOI positions (used as chunk boundaries to contain EOI search)
  const allSois = [];
  // Track which are real JPEG headers (valid 4th byte)
  const validSoiSet = new Set();
  let pos = 0;
  while (pos < buf.length - 3) {
    const idx = buf.indexOf(soiMarker, pos);
    if (idx === -1) break;
    allSois.push(idx);
    if (VALID_JPEG_MARKERS.has(buf[idx + 3])) validSoiSet.add(idx);
    pos = idx + 1;
  }

  let bestBuf = null;
  for (let i = 0; i < allSois.length; i++) {
    const start = allSois[i];
    if (!validSoiSet.has(start)) continue; // skip false SOI matches
    // Use the next SOI (any) as the boundary so EOI search stays within this JPEG's data
    const searchEnd = i + 1 < allSois.length ? allSois[i + 1] : buf.length;
    const chunk = buf.slice(start, searchEnd);
    const eoiPos = chunk.lastIndexOf(eoiMarker);
    if (eoiPos <= 0) continue;
    const len = eoiPos + 2;
    // Skip tiny thumbnails (< 50KB); keep the largest
    if (len > 50000 && (!bestBuf || len > bestBuf.length)) {
      bestBuf = chunk.slice(0, len);
    }
  }
  return bestBuf; // Buffer or null
}

async function convertRawToJpeg(filePath) {
  if (previewCache.has(filePath)) return previewCache.get(filePath);

  const tmpName = `raw_preview_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  // Primary: extract embedded JPEG directly from the file buffer
  try {
    const buf = await fs.promises.readFile(filePath);
    const jpeg = extractLargestEmbeddedJpeg(buf);
    if (jpeg) {
      await fs.promises.writeFile(tmpPath, jpeg);
      tempFiles.add(tmpPath);
      previewCache.set(filePath, tmpPath);
      return tmpPath;
    }
  } catch (e) {}

  // Fallback: try ffmpeg (works for some formats)
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', filePath, '-update', '1', '-frames:v', '1', '-q:v', '2', tmpPath],
        { timeout: 20000 }, (err) => err ? reject(err) : resolve());
    });
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 5000) {
      tempFiles.add(tmpPath);
      previewCache.set(filePath, tmpPath);
      return tmpPath;
    }
  } catch (e) {}

  return null;
}

ipcMain.handle('convert-raw-preview', async (event, filePath) => {
  const tmpPath = await convertRawToJpeg(filePath);
  if (tmpPath) return { success: true, tmpPath };
  return { success: false };
});

// Pre-convert a list of upcoming RAW files in the background (for queue)
ipcMain.handle('preconvert-raw-previews', async (event, filePaths) => {
  (async () => {
    for (const fp of filePaths) {
      if (!previewCache.has(fp)) {
        await convertRawToJpeg(fp).catch(() => {});
      }
    }
  })();
  return { success: true };
});

ipcMain.handle('delete-temp-preview', async (event, tmpPath) => {
  try {
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
      tempFiles.delete(tmpPath);
    }
    for (const [key, val] of previewCache) {
      if (val === tmpPath) { previewCache.delete(key); break; }
    }
  } catch (e) {}
  return { success: true };
});

app.on('before-quit', () => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
});
