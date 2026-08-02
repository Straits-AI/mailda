import { drizzle } from "drizzle-orm/d1";

export interface Env {
  CATALOG: D1Database;
}

/**
 * The `state` Worker (#4): sole owner of D1 and every Durable Object class.
 * Other Workers reach it by service-binding RPC. It has no public route.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("state worker: RPC only", { status: 404 });
  },
};

export function db(env: Env) {
  return drizzle(env.CATALOG);
}
