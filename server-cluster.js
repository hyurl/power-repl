const { serve } = require(".");
const os = require("os");
const cluster = require("cluster");

if (cluster.isMaster) {
    cluster.fork();
} else {
    serve(os.tmpdir() + "/power-repl.sock");
}