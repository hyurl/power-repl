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
function isRecoverableError(err) {
    if (err instanceof Error && err.name === 'SyntaxError') {
        return /^(Unexpected end of input|Unexpected token)/.test(err.message);
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
        let sessions = new Set();
        let wrapWrite = (target) => {
            let fn = target.write.bind(target);
            return (...args) => {
                if (sessions.size > 0) {
                    for (let socket of sessions) {
                        socket.write.apply(socket, args);
                    }
                    return true;
                }
                else {
                    return fn(...args);
                }
            };
        };
        process.stdout.write = wrapWrite(process.stdout);
        process.stderr.write = wrapWrite(process.stderr);
        let server = net.createServer(socket => {
            let replServer;
            socket.on("close", () => {
                replServer && replServer.close();
            }).on("error", err => {
                if (!isSocketResetError(err)) {
                    console.error(err);
                }
            }).once("data", buf => {
                try {
                    let connOpts = JSON.parse(String(buf));
                    !connOpts.noStdout && sessions.add(socket);
                    replServer = repl.start({
                        prompt: connOpts.prompt,
                        input: socket,
                        output: socket,
                        useColors: true,
                        useGlobal: true,
                        eval(code, context, filename, callback) {
                            return tslib_1.__awaiter(this, void 0, void 0, function* () {
                                try {
                                    let asyncCode;
                                    let result;
                                    if (AllowAwait) {
                                        asyncCode = node_repl_await_1.processTopLevelAwait(code);
                                    }
                                    if (asyncCode) {
                                        result = yield vm.runInThisContext(asyncCode);
                                    }
                                    else {
                                        result = vm.runInThisContext(code);
                                    }
                                    callback(null, result);
                                }
                                catch (err) {
                                    if (isRecoverableError(err)) {
                                        callback(new repl.Recoverable(err), void 0);
                                    }
                                    else {
                                        if (err instanceof Error) {
                                            let stack = err.stack;
                                            let lines = stack.split("\n").slice(1);
                                            let end = lines.findIndex(line => {
                                                return /Error:/.test(line);
                                            }) + 1;
                                            lines = end > 0 ? lines.slice(0, end) : lines;
                                            err.stack = lines.join("\n");
                                        }
                                        callback(err, void 0);
                                    }
                                }
                            });
                        }
                    });
                    replServer.on("exit", () => {
                        !connOpts.noStdout && sessions.delete(socket);
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
                let data = pick(options, ["prompt", "noStdout"]);
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
        options.prompt = options.prompt || "> ";
        options.history = options.history || process.cwd() + "/.power_repl_history";
        options.historySize = options.historySize || 100;
        let canExit = false;
        let input = readline.createInterface(Object.assign({ input: process.stdin, output: process.stdout }, pick(options, [
            "prompt",
            "historySize",
            "removeHistoryDuplicates"
        ])));
        input.on("line", line => {
            canExit = false;
            socket.write(line + "\n");
        });
        socket.on("data", (buf) => {
            let str = buf.slice(0, 5).toString();
            if (str === "... ") {
                input.setPrompt("... ");
            }
            else if (str === options.prompt) {
                input.setPrompt(options.prompt);
            }
            else if (str === options.prompt + options.prompt) {
                buf = buf.slice(0, -options.prompt.length);
            }
            process.stdout.write(buf);
        });
        let history = [];
        try {
            history = (yield fs.readFile(options.history, "utf8")).split("\n");
            history.reverse();
        }
        catch (err) { }
        if (history.length > 0) {
            input["history"] = (input["history"] || []).concat(history);
        }
        socket.on("close", (hadError) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            history = input["history"];
            history.reverse();
            yield fs.ensureDir(path.dirname(options.history));
            yield fs.writeFile(options.history, history.join("\n"), "utf8");
            input.close();
            process.exit(hadError ? 1 : 0);
        })).on("error", (err) => {
            if (!isSocketResetError(err)) {
                console.error(err);
            }
        });
        input.on("SIGINT", () => {
            if (canExit) {
                socket.destroy();
            }
            else if (input["_prompt"] === "... ") {
                process.stdout.write("\n");
                socket.write(".break\n");
            }
            else {
                canExit = true;
                console.info('\n(To exit, press ^C or ^D again or type .exit)');
                input.prompt(true);
            }
        }).on("pause", () => {
            socket.destroy();
        });
        return socket;
    });
}
exports.connect = connect;
//# sourceMappingURL=index.js.map