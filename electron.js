/* eslint-disable max-lines */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-unused-vars */

const { protocol, app, Menu, BrowserWindow, ipcMain } = require('electron');

const { CompanionServer, setLogger, DevelopmentLogger, ProductionLogger } = require('@tempo/curlflix-electron-main');
const isDevelopment = require('electron-is-dev');

const log = isDevelopment ? DevelopmentLogger : ProductionLogger;
setLogger(log);

log.info('Curlflix starting');

const path = require('path');
const Sentry = require('@sentry/node');
const { readFileSync } = require('fs');
const { exec } = require('child_process');

const { JsonRpcIpcMain } = isDevelopment
  ? require('../src/ipc/JsonRpcIpc.js')
  : require(app.getAppPath() + '/build/JsonRpcIpc.js');

const { ZmqSockets } = isDevelopment
  ? require('../src/utils/ZmqSockets.js')
  : require(app.getAppPath() + '/build/ZmqSockets.js');

// global reference to mainWindow (necessary to prevent window from being garbage collected)
let mainWindow;

if (process.argv.includes('--version')) {
  log.info(app.getVersion());
  process.exit();
}

initSentry();

log.info('Sentry initialized');

// Allow only one instance to run
if (+process.env.CURLFLIX_MULTI_INSTANCE !== 1 && !app.requestSingleInstanceLock()) {
  log.info('Secondary instance, quitting');
  app.quit();
  return;
}

// Disable console logging of security warnings (for webSecurity, blink options)
// as these don't apply for our localhost context
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = true;

// Disables CORS preflights, as `webSecurity: false` is affected by:
// https://github.com/electron/electron/issues/23664
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

const installExtensions = () => {
  if (isDevelopment) {
    log.info('Installing React dev tools');
    const installer = require('electron-devtools-installer'); // eslint-disable-line global-require

    const extensions = ['REACT_DEVELOPER_TOOLS', 'APOLLO_DEVELOPER_TOOLS', 'REDUX_DEVTOOLS'];
    const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
    return Promise.all(extensions.map((name) => installer.default(installer[name], forceDownload)));
  }

  return Promise.resolve([]);
};

function createMainWindow() {
  log.info('Creating main window');

  const window = new BrowserWindow({
    width: 1080,
    height: 1920,
    icon: path.join(__dirname, '/icon.png'),
    webPreferences: {
      webSecurity: false,
      allowRunningInsecureContent: false,
      nodeIntegration: true,
      enableRemoteModule: true, // we are calling `electron.remote` which is deprecated. this flag is required by electron >= v10
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: isDevelopment ? undefined : '#000000',
    show: isDevelopment,
  });

  log.info('Main window created');

  // to enable embedding of terms & privacy pages from the tempo.fit site in an iframe we need to remove
  // the x-frame-options header. https://gitlab.com/tempo/curlflix/-/issues/1244
  // NOTE: we could remove this header from the site but that would expose the site to click hijacking.
  window.webContents.session.webRequest.onHeadersReceived({ urls: [`https://tempo.fit/*`] }, (details, callback) => {
    callback({
      responseHeaders: Object.fromEntries(
        Object.entries(details.responseHeaders).filter((header) => !/x-frame-options/i.test(header[0]))
      ),
    });
  });

  // This allows getting request timing and size information from `performance`
  window.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Timing-Allow-Origin': '*' },
    });
  });

  // For customer devices we start with the main window hidden, and then show it only after
  // the splash screen is ready, to prevent unstyled flashes
  if (!isDevelopment) {
    function showMainWindow() {
      // Goes full screen, unless CURLFLIX_FULL_SCREEN is explicitly 0
      const fullScreen = process.env.CURLFLIX_FULL_SCREEN !== '0';
      if (fullScreen) {
        window.setKiosk(true);
        window.setFullScreen(true);
      }

      window.show();
    }

    // Just in case the message below is not sent
    const fallback = setTimeout(() => {
      log.info('Main window shown via fallback; no message received from splash');
      showMainWindow();
    }, 10000);

    ipcMain.once('show-main-window', () => {
      clearTimeout(fallback);

      log.info('Showing main window');
      showMainWindow();
      log.info('Main window shown');
    });
  }

  const zmqUrl = 'tcp://localhost:5576';
  const zmq = new JsonRpcIpcMain(
    {
      socketName: ZmqSockets.kinetic,
      socketUrl: zmqUrl,
      connectionMethod: 'connect',
      autoConnect: true,
    },
    window
  );
  log.info(`Zmq bound to ${zmq.url}`);

  const forceDevTools = process.env.CURLFLIX_FORCE_DEV_TOOLS || false;

  if (isDevelopment || forceDevTools) {
    window.webContents.on('context-menu', (e, props) => {
      const { x, y } = props;

      Menu.buildFromTemplate([
        {
          label: 'Inspect element',
          click() {
            mainWindow.inspectElement(x, y);
          },
        },
      ]).popup(mainWindow);
    });

    window.webContents.once('dom-ready', () => {
      window.webContents.openDevTools({ mode: process.env.CURLFLIX_DEV_TOOLS_MODE || 'undocked' });
    });

    if (process.env.CURLFLIX_MAXIMIZE) {
      window.maximize();
    }
  }

  const url = isDevelopment ? 'http://localhost:4000' : `file://${path.join(__dirname, '../build/index.html')}`;
  log.info(`Loading web content from ${url}`);
  window.loadURL(url);

  window.on('closed', () => {
    log.info('Main window closed');
    mainWindow = null;
  });

  window.webContents.on('devtools-opened', () => {
    log.info('Dev tools opened');
    window.focus();
    setImmediate(() => {
      window.focus();
    });
  });

  return window;
}

// quit application when all windows are closed
app.on('window-all-closed', () => {
  log.info('All windows closed: quitting');
  // on macOS it is common for applications to stay open until the user explicitly quits
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  log.info('On activate');
  // on macOS it is common to re-create a window even after all windows have been closed
  if (mainWindow === null) {
    mainWindow = createMainWindow();
  }
});

// create main BrowserWindow when electron is ready
app.on('ready', () => {
  log.info('On ready');

  // Allows access to local files from renderer process
  const protocolName = 'local-file';
  protocol.registerFileProtocol(protocolName, (request, callback) => {
    const url = request.url.replace(`${protocolName}://`, '');
    try {
      return callback(decodeURIComponent(url));
    } catch (error) {
      // Handle the error as needed
      console.error(error);
    }
  });

  // Needed to allow native modules in renderer processes (which should be avoided)
  app.allowRendererProcessReuse = false;
  // We use `finally` instead of `then` to make sure that window gets created even
  // if installing extensions fails
  return installExtensions().finally(() => {
    mainWindow = createMainWindow();

    const companionServer = new CompanionServer(ipcMain, mainWindow.webContents);
    mainWindow.companionServer = companionServer;
  });
});

app.on('second-instance', () => {
  log.info('Another instance launched, bringing window to front');

  // Focus the window if another instance attempted to start
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  }
});

// Let the renderer know about this signal
process.on('SIGUSR1', () => {
  log.info('On SIGUSR1');
  if (mainWindow && mainWindow.webContents && mainWindow.webContents.send) {
    // The main window is notified about the shutdown request
    mainWindow.webContents.send('shutdown-request');

    // It needs to acknowlege it in, 5s or we force the shutdown
    const shutdownTimeout = setTimeout(() => {
      // This does not require sudo
      exec('shutdown -P now');

      // Would be nice to have analytics here, when segment is added via yarn
    }, 5000);

    // If acknowleged, we cancel the forced shutdown
    ipcMain.once('shutdown-acknowledged', () => {
      clearTimeout(shutdownTimeout);
    });
  }
});

function initSentry() {
  try {
    Sentry.init({
      dsn: 'https://c532d7ce37464b789772847d55c5c7e3@o213076.ingest.sentry.io/1728465',
      environment: isDevelopment ? 'development' : 'production',
      release: 'cf-' + app.getVersion(),
      // Need to turn off the default OnUncaughtException integration, as it forces the app to exit
      integrations: (defaults) => defaults.filter((integration) => integration.name !== 'OnUncaughtException'),
      ignoreErrors: [
        // see https://forum.sentry.io/t/resizeobserver-loop-limit-exceeded/8402
        'ResizeObserver loop limit exceeded',
      ],
    });

    // Our handler just reports the errors and notifies the renderer
    process.on('uncaughtException', (error) => {
      Sentry.captureException(error);
      log.error('uncaughtException', error);
      if (mainWindow) {
        // This sends an async message to the renderer; used by CurlflixUpdateService to detect if such
        // an exception happens during the update in order to abort the update
        mainWindow.webContents.send('uncaughtException', error);
      }
    });

    function readFileString(filePath) {
      try {
        return readFileSync(filePath).toString().trim();
      } catch {
        return '';
      }
    }

    const machineId = readFileString('/etc/machine-id');
    const serial = readFileString('/etc/serial');

    Sentry.configureScope((scope) => scope.setTags({ area: 'electron-main', machineId, serial }));
  } catch (error) {
    log.error('Failed to initialize Sentry', error);
  }
}
