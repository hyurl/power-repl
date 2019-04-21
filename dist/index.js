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
const pick = require("lodash/pick");
const AllowAwait = parseFloat(process.version.slice(1)) >= 7.6;
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
function serve(arg) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let options = typeof arg === "string" ? { path: arg } : arg;
        let sockPath = options["path"];
        let stdoutSessions = new Set();
        let _write = process.stdout.write;
        process.stdout.write = (...args) => {
            let res = _write.apply(process.stdout, args);
            for (let socket of stdoutSessions) {
                socket.write.apply(socket, args);
            }
            return res;
        };
        let server = net.createServer(socket => {
            let replServer;
            socket.on("close", () => {
                replServer && replServer.close();
            }).on("error", err => {
                if (!isSocketResetError(err)) {
                    console.log(err);
                }
            }).once("data", buf => {
                try {
                    let connOpts = JSON.parse(String(buf));
                    !connOpts.noStdout && stdoutSessions.add(socket);
                    replServer = repl.start({
                        input: socket,
                        output: socket,
                        useColors: true,
                        useGlobal: true,
                        eval(code, context, filename, callback) {
                            return tslib_1.__awaiter(this, void 0, void 0, function* () {
                                code = AllowAwait
                                    ? (node_repl_await_1.processTopLevelAwait(code) || code)
                                    : code;
                                try {
                                    callback(null, yield vm.runInNewContext(code, context, { filename }));
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
                        !connOpts.noStdout && stdoutSessions.delete(socket);
                        socket.destroy();
                    });
                }
                catch (err) {
                    socket.destroy();
                }
            });
        });
        if (sockPath) {
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
            if (sockPath) {
                if (yield fs.pathExists(sockPath)) {
                    yield fs.unlink(sockPath);
                }
                options["path"] = resolveSockPath(sockPath);
            }
            server.listen(options, () => {
                server.removeListener("error", reject);
                resolve(server);
            }).once("error", reject);
        }));
    });
}
exports.serve = serve;
function connect(arg) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let options = typeof arg === "string" ? { path: arg } : arg;
        let sockPath = options["path"];
        let socket = yield new Promise((resolve, reject) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            let socket = new net.Socket();
            socket.once("error", reject).once("connect", () => {
                socket.removeListener("error", reject);
                let data = pick(options, ["noStdout"]);
                socket.write(JSON.stringify(data), err => {
                    err ? reject(err) : resolve(socket);
                });
            });
            if (sockPath) {
                if (os.platform() === "win32" && (yield fs.pathExists(sockPath))) {
                    try {
                        let port = Number(yield fs.readFile(sockPath, "utf8"));
                        socket.connect({
                            port,
                            host: "127.0.0.1",
                            timeout: options.timeout
                        });
                    }
                    catch (err) {
                        reject(err);
                    }
                    return;
                }
                options["path"] = resolveSockPath(sockPath);
            }
            socket.connect(options);
        }));
        options.history = options.history || process.cwd() + "/.node_repl_history";
        options.historySize = options.historySize || 100;
        let input = readline.createInterface(Object.assign({ input: process.stdin, output: process.stdout }, pick(options, [
            "historySize",
            "removeHistoryDuplicates"
        ])));
        input.on("line", line => {
            socket.write(line + "\n");
        });
        socket.pipe(process.stdout);
        let addHistory = input["_addHistory"];
        let history = [];
        let REPLKeyword = /^\s*\./;
        try {
            history = (yield fs.readFile(options.history, "utf8")).split("\n");
        }
        catch (err) { }
        if (history.length > 0) {
            input["history"] = (input["history"] || []).concat(history);
        }
        input["_addHistory"] = function (...args) {
            let line = addHistory.apply(input, args);
            if (REPLKeyword.test(line[0]) === false) {
                history = [].concat(input["history"]);
            }
            return line;
        };
        socket.on("close", (hadError) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            yield fs.ensureDir(path.dirname(options.history));
            yield fs.writeFile(options.history, history.join("\n"), "utf8");
            input.close();
            process.exit(hadError ? 1 : 0);
        })).on("error", (err) => {
            if (!isSocketResetError(err)) {
                console.log(err);
            }
        });
        return socket;
    });
}
exports.connect = connect;
//# sourceMappingURL=index.js.map