import * as os from "os";
import * as vm from "vm";
import * as net from "net";
import * as repl from "repl";
import * as path from "path";
import * as fs from "fs-extra";
import * as cluster from "cluster";
import * as readline from "readline";
import { processTopLevelAwait } from "node-repl-await";
import isSocketResetError = require('is-socket-reset-error');
import pick = require("lodash/pick");

const AllowAwait = parseFloat(process.version.slice(1)) >= 7.6;

function isRecoverableError(error: Error) {
    if (error.name === 'SyntaxError') {
        return /^(Unexpected end of input|Unexpected token)/.test(error.message);
    }
    return false;
}

function resolveSockPath(path: string) {
    if (os.platform() !== "win32" || path.slice(0, 9) === "\\\\.\\pipe\\") {
        return path;
    } else {
        return "\\\\.\\pipe\\" + path;
    }
}

export async function serve(path: string): Promise<net.Server>;
export async function serve(options: net.ListenOptions): Promise<net.Server>;
export async function serve(arg: string | net.ListenOptions) {
    let options = typeof arg === "string" ? { path: arg } : arg;
    let sockPath: string = options["path"];
    let stdoutSessions = new Set<net.Socket>();
    let _write = process.stdout.write;

    // Rewrite the stdout.write method to allow data being redirected to sockets.
    process.stdout.write = (...args: any[]) => {
        let res = _write.apply(process.stdout, args);

        for (let socket of stdoutSessions) {
            socket.write.apply(socket, args);
        }

        return res;
    };

    let server = net.createServer(socket => {
        let replServer: repl.REPLServer;

        // When the socket is closed, whether before exiting the REPL session or
        // other situations, make sure the REPL server for the current socket is
        // also closed.
        socket.on("close", () => {
            replServer && replServer.close();
        }).on("error", err => {
            // A socket reset error happens when the REPL server is about to
            // output data, the socket connection got lost. Since the evaluation
            // is succeed, the reset error can be ignored.
            if (!isSocketResetError(err)) {
                console.log(err);
            }
        }).once("data", buf => {
            // HANDSHAKE
            // Every client that connects to the REPL server, once the
            // connection is established, the client shall send a JSON message
            // of options for handshake and to config the session immediately.
            // The server will try to parse the first frame as handshake config,
            // however if the first frame of data is malformed, it should be
            // considered that the connection is unrecognized, and terminate the
            // connection immediately.
            try {
                let connOpts: ConnectOptions = JSON.parse(String(buf));

                !connOpts.noStdout && stdoutSessions.add(socket);

                // Create a new REPL server for every connection.
                replServer = repl.start({
                    input: socket,  // Bind input and output stream of the REPL
                    output: socket, // session directly to the socket.
                    useColors: true,
                    useGlobal: true,
                    async eval(code, context, filename, callback) {
                        // Backed by `processTopLevelAwait`, any `await` 
                        // statement can be resolved in this eval function.
                        code = AllowAwait
                            ? (processTopLevelAwait(code) || code)
                            : code;

                        try {
                            callback(null, await vm.runInNewContext(
                                code,
                                context,
                                { filename }
                            ));
                        } catch (err) {
                            if (isRecoverableError(err)) {
                                callback(new repl.Recoverable(err), void 0);
                            } else {
                                callback(err, void 0);
                            }
                        }
                    }
                });

                // When receiving the `.exit` command, destroy the socket as 
                // well.
                replServer.on("exit", () => {
                    !connOpts.noStdout && stdoutSessions.delete(socket);
                    socket.destroy();
                });
            } catch (err) {
                socket.destroy();
            }
        });
    });

    if (sockPath) {
        // Ensures the directory of socket path exists.
        await fs.ensureDir(path.dirname(sockPath));

        if (cluster.isWorker && os.platform() === "win32") {
            return new Promise((resolve, reject) => {
                // On Windows systems, cluster workers are not able to serve
                // named pipe, so listen to a random port instead. After 
                // listening, save the port to the socket path, so the client
                // can find the port from the socket path.
                server.listen(0, "127.0.0.1", async () => {
                    try {
                        let { port } = (<net.AddressInfo>server.address());

                        await fs.writeFile(sockPath, String(port), "utf8");

                        server.removeListener("error", reject);
                        resolve(server);
                    } catch (err) {
                        reject(err);
                    }
                }).once("error", reject);
            });
        }
    }

    return new Promise(async (resolve, reject) => {
        // When listening to a socket path, if the path already exists, e.g.
        // created at the last time running the program, it must be removed
        // before listening again.
        if (sockPath) {
            if (await fs.pathExists(sockPath)) {
                await fs.unlink(sockPath);
            }

            options["path"] = resolveSockPath(sockPath);
        }

        server.listen(options, () => {
            server.removeListener("error", reject);
            resolve(server);
        }).once("error", reject);
    });
}

export interface ConnectOptions {
    [x: string]: any;
    path?: string;
    port?: number;
    host?: string;
    timeout?: number;
    noStdout?: boolean;
    history?: string;
    historySize?: number;
    removeHistoryDuplicates?: boolean;
}

export async function connect(path: string): Promise<net.Socket>;
export async function connect(options: ConnectOptions): Promise<net.Socket>;
export async function connect(arg: string | ConnectOptions) {
    let options = typeof arg === "string" ? { path: arg } : arg;
    let sockPath: string = options["path"];
    let socket: net.Socket = await new Promise(async (resolve, reject) => {
        let socket: net.Socket = new net.Socket();

        socket.once("error", reject).once("connect", () => {
            socket.removeListener("error", reject);

            let data = pick(options, ["noStdout"]);

            // HANDSHAKE
            socket.write(JSON.stringify(data), err => {
                err ? reject(err) : resolve(socket);
            });
        });

        if (sockPath) {
            if (os.platform() === "win32" && (await fs.pathExists(sockPath))) {
                // If the REPL server runs in a cluster worker and the system is
                // Windows, it will listens a random port and store the port in
                // the socket path as a regular file, when providing a socket 
                // path and detecting the path is a regular file, get the 
                // listening port from the file for connection instead of 
                // binding the socket to the file.
                try {
                    let port = Number(await fs.readFile(sockPath, "utf8"));

                    socket.connect(<net.NetConnectOpts>{
                        port,
                        host: "127.0.0.1",
                        timeout: options.timeout
                    });
                } catch (err) {
                    reject(err);
                }

                return;
            }

            options["path"] = resolveSockPath(sockPath);
        }

        socket.connect(<net.NetConnectOpts>options);
    });

    options.history = options.history || process.cwd() + "/.node_repl_history";
    options.historySize = options.historySize || 100;

    // Create a new readline interface instead of using the `process.stdin`
    // directly, since the later causes some problem in Unix terminals, e.g.
    // when pressing keys like 'Up' and 'Down', instead of giving history
    // suggestions, process.stdin causes inputting malformed characters.
    let input = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        ...pick(options, [
            "historySize",
            "removeHistoryDuplicates"
        ])
    });

    // Write every line inputted to the socket stream.
    input.on("line", line => {
        socket.write(line + "\n");
    });

    // Pipe any output data (eval result from the REPL server) to the standard
    // output stream.
    socket.pipe(process.stdout);

    // HACK for persistent history support.
    let addHistory: Function = input["_addHistory"];
    let history: string[] = [];
    let REPLKeyword = /^\s*\./;

    // Try to load history form file.
    try {
        history = (await fs.readFile(options.history, "utf8")).split("\n");
    } catch (err) { }

    // Patch history to the readline interface.
    if (history.length > 0) {
        input["history"] = (<string[]>input["history"] || []).concat(history);
    }

    // History support needs to rewrite Node.js readline._addHistory method.
    input["_addHistory"] = function (this: readline.Interface, ...args: any[]) {
        let line = addHistory.apply(input, args);

        if (REPLKeyword.test(line[0]) === false) { // do not log REPL keyword
            history = [].concat(input["history"]);
        }

        return line;
    }

    // When the socket is closed, also write history to the given path, and
    // close the readline interface as well, then exit the process.
    socket.on("close", async (hadError) => {
        await fs.ensureDir(path.dirname(options.history));
        await fs.writeFile(options.history, history.join("\n"), "utf8");

        input.close();
        process.exit(hadError ? 1 : 0);
    }).on("error", (err) => {
        if (!isSocketResetError(err)) {
            console.log(err);
        }
    });

    return socket;
}