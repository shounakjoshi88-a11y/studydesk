import { registerPlugin, WebPlugin } from "@capacitor/core";

export interface NativeHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  location?: string;
}

export interface NativeHttpPlugin {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<NativeHttpResponse>;
}

export class NativeHttpWeb extends WebPlugin implements NativeHttpPlugin {
  async request(o: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<NativeHttpResponse> {
    const r = await fetch(o.url, {
      method: o.method || "GET",
      headers: o.headers,
      body: o.body,
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: r.status,
      body: await r.text(),
      headers,
      location: r.headers.get("location") || undefined,
    };
  }
}

export const NativeHttp = registerPlugin<NativeHttpPlugin>("NativeHttp", {
  web: () => Promise.resolve().then(() => new NativeHttpWeb()),
});
