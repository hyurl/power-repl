const { connect } = require(".");
const os = require("os");

connect({
    path: os.tmpdir() + "/power-repl.sock",
    noStdout: true
});