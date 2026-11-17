import { createApp } from "./app.js";
const { app, close } = createApp();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`Approval Hub API: http://${host}:${port}`),
);
function stop() {
  server.close(() => {
    close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
