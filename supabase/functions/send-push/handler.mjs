import { timingSafeEqual } from "node:crypto";

export function safeEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
function sameSecret(a, b) {
  const left = new TextEncoder().encode(a),
    right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function createPushHandler({ client, webpush, fetcher = fetch }) {
  const response = (status, value) =>
    new Response(JSON.stringify(value), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  return async function handle(request) {
    if (request.method !== "POST")
      return response(405, { error: "Method not allowed" });
    const secret = request.headers.get("X-Push-Secret") || "";
    if (!/^[a-f0-9]{64}$/.test(secret))
      return response(401, { error: "Unauthorized" });
    try {
      const config = await client.rpc("club_push_config");
      if (config.error || !config.data)
        return response(503, { error: "Push unavailable" });
      if (!sameSecret(secret, config.data.secret))
        return response(401, { error: "Unauthorized" });
      const claimed = await client.rpc("club_claim_push");
      if (claimed.error) throw new Error("Queue unavailable");
      const results = await Promise.all(
        (claimed.data || []).map(async (job) => {
          let status = 0;
          if (!safeEndpoint(job.subscription?.endpoint)) status = 400;
          else {
            try {
              const details = webpush.generateRequestDetails(
                job.subscription,
                JSON.stringify(job.payload),
                {
                  TTL: 86400,
                  urgency: "high",
                  vapidDetails: {
                    subject: "mailto:admin@your-entity.example",
                    publicKey: config.data.publicKey,
                    privateKey: config.data.privateKey,
                  },
                },
              );
              const result = await fetcher(details.endpoint, {
                method: "POST",
                headers: details.headers,
                body: details.body,
                redirect: "error",
                signal: AbortSignal.timeout(12000),
              });
              status = result.status;
              await result.body?.cancel();
            } catch {
              status = 0;
            }
          }
          const saved = await client.rpc("club_finish_push", {
            p_id: job.id,
            p_attempt: job.attempt,
            p_status: status,
          });
          if (saved.error) throw new Error("Could not save delivery status");
          return status >= 200 && status < 300;
        }),
      );
      return response(200, {
        processed: results.length,
        delivered: results.filter(Boolean).length,
      });
    } catch {
      // Never log device endpoints, encryption keys, or webhook credentials.
      return response(503, {
        error: "Delivery deferred; queued notifications will retry.",
      });
    }
  };
}
