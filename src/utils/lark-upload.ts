/**
 * Minimal Lark image uploader callable from worker process.
 * Worker doesn't load bot-registry — it has LARK_APP_ID/LARK_APP_SECRET in env
 * (see worker-pool.ts forkWorker).
 */
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';

let cached: { client: any; appId: string } | null = null;

function getClient(appId: string, secret: string) {
  if (cached && cached.appId === appId) return cached.client;
  cached = {
    appId,
    client: new Client({ appId, appSecret: secret, loggerLevel: LoggerLevel.error }),
  };
  return cached.client;
}

export async function uploadImageBuffer(appId: string, secret: string, buf: Buffer): Promise<string> {
  const c = getClient(appId, secret);
  const res = await c.im.v1.image.create({
    data: { image_type: 'message', image: buf },
  });
  const key = res?.image_key;
  if (!key) throw new Error(`upload failed: ${JSON.stringify(res)}`);
  return key;
}
