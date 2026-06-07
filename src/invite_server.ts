import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import mongo from "./db";
import { qbt_client, create_invitation_opts, qbt_contact_method } from "./qbt_client_interface";
import { normalize_email, normalize_phone_number } from "./sync_users";

// Local-only: this server answers invite requests from another node process on
// the same droplet, so it binds to loopback rather than a public interface.
const HOST = "127.0.0.1";
const PORT = 3001;

type invite_body = {
    hres_id: string;
    contact_method: qbt_contact_method;
};

// Fastify validates the body against this before our handler runs, so the
// handler can trust hres_id is a non-empty string and contact_method is valid.
const invite_body_schema = {
    type: "object",
    required: ["hres_id", "contact_method"],
    additionalProperties: false,
    properties: {
        hres_id: { type: "string", minLength: 1 },
        contact_method: { type: "string", enum: ["sms", "email"] },
    },
} as const;

// Resolves an invite request to a QBT invitation and sends it. Body validation
// is handled by invite_body_schema before this runs, so hres_id is a non-empty
// string and contact_method is valid here.
async function handle_invite(
    qbt: qbt_client,
    req: FastifyRequest<{ Body: invite_body }>,
    reply: FastifyReply
): Promise<FastifyReply> {
    const { hres_id, contact_method } = req.body;

    // Prefer an existing QBT user: if this hres is already mapped to one,
    // invite by user_id. Otherwise fall back to the hresource's own contact
    // details matching the requested method.
    const mapping = await mongo.get_qbt_map_objects().findOne({ type: "user", our_id: hres_id });

    let invite: create_invitation_opts;
    if (mapping) {
        invite = { contact_method, user_id: mapping.qbt_id };
    } else {
        const hres = await mongo.get_hresources().findOne({ _id: hres_id });
        if (!hres) {
            return reply
                .code(404)
                .send({ ok: false, error: `No QBT user mapping or hresource found for hres_id ${hres_id}` });
        }
        const contact_info =
            contact_method === "email" ? normalize_email(hres.email) : normalize_phone_number(hres.phone_number);
        if (!contact_info) {
            const field = contact_method === "email" ? "email" : "phone number";
            return reply.code(422).send({ ok: false, error: `hresource ${hres_id} has no ${field} to invite` });
        }
        invite = { contact_method, contact_info };
    }

    try {
        const result = await qbt.create_invitation(invite);
        ilog(`[invite] hres ${hres_id} via ${contact_method}:`, invite, "->", result);
        return reply.send({ ok: true, invite, result });
    } catch (err) {
        elog(`[invite] QBT invitation failed for hres ${hres_id}:`, err);
        return reply.code(502).send({ ok: false, error: String(err) });
    }
}

// Starts the invite endpoint on the shared mongo connection + qbt client owned
// by the caller (the sync service). Returns the listening Fastify instance so
// the caller can close it on shutdown.
export async function start_invite_server(qbt: qbt_client): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });

    app.post<{ Body: invite_body }>("/invitation", { schema: { body: invite_body_schema } }, (req, reply) =>
        handle_invite(qbt, req, reply)
    );

    await app.listen({ host: HOST, port: PORT });
    ilog(`[invite] Listening on http://${HOST}:${PORT}`);
    return app;
}
