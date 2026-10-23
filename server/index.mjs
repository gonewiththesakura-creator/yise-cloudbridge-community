import { createFriendLinkApp } from './app.mjs';

const app = createFriendLinkApp();
const { port, host } = app.options;

app.server.listen(port, host, () => {
  console.log(`${app.options.productName} console listening on http://${host}:${port}`);
});

if (app.dataPlane) {
  app.dataPlane.server.listen(app.options.dataPlanePort, app.options.dataPlaneHost, () => {
    console.log(`${app.options.productName} mTLS data plane listening on ${app.options.dataPlaneHost}:${app.options.dataPlanePort}`);
  });
}

const shutdown = () => app.close();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
