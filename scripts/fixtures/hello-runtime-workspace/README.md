# Order application

## Run locally

Use Node.js 18 or newer:

```sh
node server.js
```

The HTTP server binds to loopback and uses the configured `PORT` value (or port 5000 by default). Open `http://localhost:<port>/orders` for the standalone interactive form, or use `POST /api/orders` as the JSON API. `.env.example` documents optional settings; the generated server does not load `.env` files automatically, so set environment variables in your shell when you need to override defaults. The server uses Node.js built-ins and does not require dependency installation to start. Its generated data model stores records in memory; configure durable persistence before production use.

The React form and App Router page source are also included for integration into a React-capable frontend.
