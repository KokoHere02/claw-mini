import { serve } from "@hono/node-server";
import { Hono } from 'hono';
import feishuRouter from '@/routes/feishu';
import { config } from '@/config';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({ 
    code: 0,
    timeStamp: new Date().toISOString(),
    service: 'claw-mini',
  });
});

app.route('/feishu', feishuRouter);


app.notFound((c) => {
  return c.json({ code: 404, msg: "Not Found" }, 404);
});
console.log(config)

serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port
  },
  (info) => {
    console.log(
      `LiteClaw server listening on http://${info.address}:${info.port}`
    );
  }
);

