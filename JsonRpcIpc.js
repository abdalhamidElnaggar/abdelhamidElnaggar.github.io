/* eslint-disable no-restricted-syntax */ // Avoids models dep for console.*
exports.__esModule = true;
var electron_1 = require('electron');
var zmq = require('zeromq');
var zoom_1 = require('zoom');
var zoom_2 = require('zoom');
var JsonRpcIpcMain = /** @class */ (function () {
  function JsonRpcIpcMain(socketConf, w) {
    this.isConnected = false;
    this.debug = false;
    this.w = w;
    this.url = socketConf.socketUrl;
    this.socketName = socketConf.socketName;
    if (this.w === undefined) {
      console.error('JsonRpcIpcMain: window (2nd argument) is undefined!');
    }
    this.socket = zmq.socket('pair');
    socketConf.autoConnect && this.url && this.connect(undefined, this.url, socketConf.connectionMethod);
    this.socket.on('message', this.handleMessage.bind(this));
    electron_1.ipcMain.on('outgoing-zmq-request-' + this.socketName, this.handleOutgoingRequest.bind(this));
    electron_1.ipcMain.on('outgoing-zmq-response-' + this.socketName, this.handleOutgoingResponse.bind(this));
    if (!socketConf.autoConnect) {
      electron_1.ipcMain.on('connect-' + this.socketName, this.connect.bind(this));
      electron_1.ipcMain.on('disconnect-' + this.socketName, this.disconnect.bind(this));
    }
  }
  JsonRpcIpcMain.prototype.connect = function (event, url, connectionMethod) {
    connectionMethod === 'bind' && this.socket.bind(url);
    connectionMethod === 'connect' && this.socket.connect(url);
    this.isConnected = true;
    this.url = url;
  };
  JsonRpcIpcMain.prototype.disconnect = function (event) {
    if (this.isConnected && this.url) {
      this.socket.disconnect(this.url);
      this.isConnected = false;
      this.url = undefined;
    }
  };
  JsonRpcIpcMain.prototype.handleMessage = function (message) {
    var data;
    var messageStr = message.toString();
    data = JSON.parse(messageStr);
    if (zoom_2.isJsonRpcResponse(data)) {
      this.w.webContents.send('incoming-zmq-response', data, this.socketName);
    } else if (zoom_1.isJsonRpcRequest(data)) {
      if (this.debug) {
        console.debug('IpcMain handling incoming request:');
        console.debug(data);
      }
      this.w.webContents.send('incoming-zmq-request', data, this.socketName);
    } else {
      console.warn('Received unexpected JSON data:');
      console.warn(data);
    }
  };
  JsonRpcIpcMain.prototype.handleOutgoingRequest = function (event, request) {
    this.isConnected && this.socket.send(JSON.stringify(request));
  };
  JsonRpcIpcMain.prototype.handleOutgoingResponse = function (event, response) {
    if (this.debug) {
      console.debug('Sending response:');
      console.debug(response);
    }
    this.isConnected && this.socket.send(JSON.stringify(response));
  };
  return JsonRpcIpcMain;
})();
exports.JsonRpcIpcMain = JsonRpcIpcMain;
