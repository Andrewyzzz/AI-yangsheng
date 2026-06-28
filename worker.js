import { onRequestPost } from "./functions/api/council.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/council") {
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      return onRequestPost({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
