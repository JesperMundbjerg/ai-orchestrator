// Capture lease HTTP decoders, beside the domain like the pipeline's; any other field is a 400.
import { fail, nonempty, object, oneOf, optional, positiveInteger, refine, sessionSchema, type Schema, type SessionInput } from "../shared/agent-protocol.ts";
import { LEASE_RESOURCES, type LeaseResource } from "../shared/leases.ts";

type LeaseRequest = { session: SessionInput; resource: LeaseResource; repo?: string };
const bounded = (max: number) => refine(nonempty, (v, p) => { if (v.length > max) fail(p, `must be at most ${max} characters`); });
const only = <T extends object>(s: Schema<T>, fields: string[]): Schema<T> => refine(s, (v, p) => {
  for (const key of Object.keys(v)) if (!fields.includes(key)) fail(p ? `${p}.${key}` : key, "is not a field of this request");
});
const base = { session: sessionSchema, resource: oneOf(LEASE_RESOURCES), repo: optional(bounded(4096)) };
const plain = only(object(base), ["session", "resource", "repo"]) as Schema<LeaseRequest>;

export const leaseSchemas = {
  acquire: only(object({ ...base, run: optional(bounded(128)), reason: optional(bounded(500)) }), ["session", "resource", "repo", "run", "reason"]) as Schema<LeaseRequest & { run?: string; reason?: string }>,
  release: plain,
  leave: plain,
  renew: plain,
  status: plain,
  revoke: only(object({ ...base, reason: bounded(500) }), ["session", "resource", "repo", "reason"]) as Schema<LeaseRequest & { reason: string }>,
  limit: only(object({ ...base, minutes: positiveInteger }), ["session", "resource", "repo", "minutes"]) as Schema<LeaseRequest & { minutes: number }>,
};
