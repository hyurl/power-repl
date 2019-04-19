const { serve } = require(".");
const os = require("os");

serve(os.tmpdir() + "/power-repl.sock");