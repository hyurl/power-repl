# PowerREPL

A powerful REPL with await and remote support.

Node.js REPL is a very useful tool, however, if you have a program, say a server
running in an individual process, how do you know the state of the process? how
can you interact with that server? The built-in REPL doesn't provide that kind
of ability, so here comes PowerREPL.

## Example

To use PowerREPL, you should serve an REPL server in your server process, say an
an HTTP server, which might look like this:

```javascript
// app.js
const http = require("http");
const { serve } = require("power-repl");

const server = http.createServer((req, res) => {
     // ...
}).listen(80);

serve("/tmp/my-app/repl.sock");
```

And then connect to the server process in another process.

```javascript
// repl.js
const { connect } = require("power-repl");

connect("/tmp/my-app/repl.sock");
```

After you started the HTTP server (`node app`), you can then interact with the
server via REPL client (`node repl`). everything is just like doing on the
server process itself.

## API

```typescript
function serve(path: string): Promise<net.Server>;
function serve(options: net.ListenOptions): Promise<net.Server>;

function connect(path: string): Promise<net.Socket>;
function connect(options: net.NetConnectOpts): Promise<net.Socket>;
```

As you can see from the API specification, you can even serve and connect to the
REPL server through the internet.

## `await` support

Backed by [node-repl-await](https://npmjs.com/package/node-repl-await), you can
freely use any `await` statement in PowerREPL, which really helps a lot.

## TODO

- Persistent history
- Tab key auto-complete