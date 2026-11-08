import { handleApi } from "../server/router.mjs";
import { runSweep } from "../server/bookings.mjs";
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

const worker = {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    // DOT Viagens API: search, OTP access, checkout, payments, invoices and admin.
    if (new URL(request.url).pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
  // Optional Cron Trigger (e.g. every minute): confirms Multicaixa Express payments on the
  // server even when the customer closed the page, and retries missing invoices.
  scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    const fetcher = (...args: Parameters<typeof fetch>) => fetch(...args);
    ctx.waitUntil(
      runSweep(env, ctx, { fetcher }).catch((error: unknown) => {
        console.error("scheduled sweep failed:", error instanceof Error ? error.message : error);
      }),
    );
  },
};

export default worker;
