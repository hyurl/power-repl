"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const os = require("os");
const vm = require("vm");
const net = require("net");
const repl = require("repl");
const path = require("path");
const fs = require("fs-extra");
const cluster = require("cluster");
const readline = require("readline");
const node_repl_await_1 = require("node-repl-await");
const isSocketResetError = require("is-socket-reset-error");
function isRecoverableError(error) {
    if (error.name === 'SyntaxError') {
        return /^(Unexpected end of input|Unexpected token)/.test(error.message);
    }
    return false;
}
function resolveSockPath(path) {
    if (os.platform() !== "win32" || path.slice(0, 9) === "\\\\.\\pipe\\") {
        return path;
    }
    else {
        return "\\\\.\\pipe\\" + path;
    }
}
function serve(options) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let server = net.createServer(socket => {
            let replServer = repl.start({
                input: socket,
                output: socket,
                useColors: true,
                useGlobal: true,
                eval(code, context, filename, callback) {
                    return tslib_1.__awaiter(this, void 0, void 0, function* () {
                        code = node_repl_await_1.processTopLevelAwait(code) || code;
                        try {
                            callback(null, yield vm.runInNewContext(code, context, {
                                filename
                            }));
                        }
                        catch (err) {
                            if (isRecoverableError(err)) {
                                callback(new repl.Recoverable(err), void 0);
                            }
                            else {
                                callback(err, void 0);
                            }
                        }
                    });
                }
            });
            replServer.on("exit", () => {
                socket.destroy();
            });
            socket.on("close", () => {
                replServer.close();
            }).on("error", err => {
                if (!isSocketResetError(err)) {
                    console.log(err);
                }
            });
        });
        if (typeof options === "string") {
            let sockPath = options;
            yield fs.ensureDir(path.dirname(sockPath));
            if (cluster.isWorker && os.platform() === "win32") {
                return new Promise((resolve, reject) => {
                    server.listen(0, "127.0.0.1", () => tslib_1.__awaiter(this, void 0, void 0, function* () {
                        try {
                            let { port } = server.address();
                            yield fs.writeFile(sockPath, String(port), "utf8");
                            server.removeListener("error", reject);
                            resolve(server);
                        }
                        catch (err) {
                            reject(err);
                        }
                    })).once("error", reject);
                });
            }
        }
        return new Promise((resolve, reject) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (typeof options === "string") {
                if (yield fs.pathExists(options)) {
                    yield fs.unlink(options);
                }
            }
            server.listen(options, () => {
                server.removeListener("error", reject);
                resolve(server);
            }).once("error", reject);
        }));
    });
}
exports.serve = serve;
function connect(options) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let isPath = typeof options === "string";
        let socketPath = isPath ? options : options["path"];
        let timeout = isPath ? void 0 : options["timeout"];
        let socket = yield new Promise((resolve, reject) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            let socket;
            if (cluster.isWorker && os.platform() === "win32" && socketPath) {
                try {
                    let port = Number(yield fs.readFile(socketPath, "utf8"));
                    socket = net.createConnection({
                        port,
                        host: "127.0.0.1",
                        timeout
                    }, () => {
                        socket.removeListener("error", reject);
                        resolve(socket);
                    }).once("error", reject);
                }
                catch (err) {
                    reject(err);
                }
            }
            else {
                if (isPath) {
                    options = resolveSockPath(options);
                }
                socket = net.createConnection(options, () => {
                    socket.removeListener("error", reject);
                    resolve(socket);
                }).once("error", reject);
            }
        }));
        let input = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        input.on("line", line => {
            socket.write(line + "\n");
        });
        socket.pipe(process.stdout);
        socket.on("close", (hadError) => {
            process.exit(hadError ? 1 : 0);
        });
        return socket;
    });
}
exports.connect = connect;
//# sourceMappingURL=index.js.map