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
export async function serve(options: string | net.ListenOptions) {
    let sessions = new Set<net.Socket>();
    let _write = process.stdout.write;

    // Rewrite the stdout.write method to allow data being redirected to sockets.
    process.stdout.write = (...args: any[]) => {
        let res = _write.apply(process.stdout, args);

        for (let socket of sessions) {
            socket.write.apply(socket, args);
        }

        return res;
    };

    let server = net.createServer(socket => {
        // Create a new REPL server for every connection.
        let replServer = repl.start({
            input: socket,  // Bind input and output stream of the REPL session
            output: socket, // directly to the socket.
            useColors: true,
            useGlobal: true,
            async eval(code, context, filename, callback) {
                // Backed by `processTopLevelAwait`, any `await` statement
                // can be resolved in this eval function.
                code = AllowAwait ? (processTopLevelAwait(code) || code) : code;

                try {
                    callback(null, await vm.runInNewContext(code, context, {
                        filename
                    }));
                } catch (err) {
                    if (isRecoverableError(err)) {
                        callback(new repl.Recoverable(err), void 0);
                    } else {
                        callback(err, void 0);
                    }
                }
            }
        });

        sessions.add(socket);

        // When receiving the `.exit` command, destroy the socket as well.
        replServer.on("exit", () => {
            sessions.delete(socket);
            socket.destroy();
        });

        // When the socket is closed, whether before exiting the REPL session or
        // other situations, make sure the REPL server for the current socket is
        // also closed.
        socket.on("close", () => {
            replServer.close();
        }).on("error", err => {
            // A socket reset error happens when the REPL server is about to
            // output data, the socket connection got lost. Since the evaluation
            // is succeed, the reset error can be ignored.
            if (!isSocketResetError(err)) {
                console.log(err);
            }
        });
    });

    if (typeof options === "string") {
        let sockPath = options;

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
        if (typeof options === "string") {
            if (await fs.pathExists(options)) {
                await fs.unlink(options);
            }

            options = resolveSockPath(options);
        }

        server.listen(options, () => {
            server.removeListener("error", reject);
            resolve(server);
        }).once("error", reject);
    });
}

export async function connect(path: string): Promise<net.Socket>;
export async function connect(options: net.NetConnectOpts): Promise<net.Socket>;
export async function connect(options: string | net.NetConnectOpts) {
    let isPath = typeof options === "string";
    let socketPath: string = isPath ? options : options["path"];
    let timeout: number = isPath ? void 0 : options["timeout"];
    let socket: net.Socket = await new Promise(async (resolve, reject) => {
        let socket: net.Socket;

        if (socketPath && os.platform() === "win32"
            && (await fs.pathExists(socketPath))) {
            // If the REPL server runs in a cluster worker and the system is
            // Windows, it will listens a random port and store the port in the
            // socket path as a regular file, when providing a socket path and
            // detecting the path is a regular file, get the listening port from
            // the file for connection instead of binding the socket to the file.
            try {
                let port = Number(await fs.readFile(socketPath, "utf8"));

                return socket = net.createConnection({
                    port,
                    host: "127.0.0.1",
                    timeout
                }, () => {
                    socket.removeListener("error", reject);
                    resolve(socket);
                }).once("error", reject);
            } catch (err) {
                return reject(err);
            }
        }

        if (isPath) {
            options = resolveSockPath(<string>options);
        }

        socket = net.createConnection(<any>options, () => {
            socket.removeListener("error", reject);
            resolve(socket);
        }).once("error", reject);
    });

    // Create a new readline interface instead of using the `process.stdin`
    // directly, since the later causes some problem in Unix terminals, e.g.
    // when pressing keys like 'Up' and 'Down', instead of giving history
    // suggestions, process.stdin causes inputting malformed characters.
    let input = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // Write every line inputted to the socket stream.
    input.on("line", line => {
        socket.write(line + "\n");
    });

    // Pipe any output data (eval result from the REPL server) to the standard
    // output stream.
    socket.pipe(process.stdout);

    socket.on("close", (hadError) => {
        process.exit(hadError ? 1 : 0);
    });

    return socket;
}