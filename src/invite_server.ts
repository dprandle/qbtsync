import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
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

// Persisted record of an invitation we created, written after QBT accepts it.
// Acts as an audit log of what went out, and in dev lets you watch invitations
// land in the "invitations" collection as they're sent.
export type invitation_doc = {
    _id: string;
    hres_id: string;
    qbt_user_id: number;
    contact_method: qbt_contact_method;
    status_code: number;
    status_message: string;
    created_at: Date;
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
async function handle_invite(qbt: qbt_client, req: FastifyRequest<{ Body: invite_body }>, reply: FastifyReply) {
    const { hres_id, contact_method } = req.body;

    // Prefer an existing QBT user: if this hres is already mapped to one,
    // invite by user_id. Otherwise fall back to the hresource's own contact
    // details matching the requested method.
    // Invite the primary (lowest link_id) QBT user if this hres has several links.
    const mapping = await mongo
        .get_qbt_map_objects()
        .findOne({ type: "user", our_id: hres_id }, { sort: { link_id: 1 } });
    if (!mapping) {
        return reply.code(404).send({
            message:
                "No quickbooks time user found. If you just enabled quickbooks time tracking, give it a minute and try again.",
        });
    }
    const invite = { contact_method, user_id: mapping.qbt_id };

    try {
        const result = await qbt.create_invitation(invite);
        ilog(`[invite] hres ${hres_id} via ${contact_method}:`, invite, "->", result);

        // Record what we sent. The invite is already out, so a failed write here
        // shouldn't fail the request — just log it and return success.
        try {
            await mongo.get_mock_invitations().insertOne({
                _id: randomUUID(),
                hres_id,
                qbt_user_id: invite.user_id,
                contact_method,
                status_code: result._status_code,
                status_message: result._status_message,
                created_at: new Date(),
            });
        } catch (err) {
            elog(`[invite] Failed to record invitation for hres ${hres_id}:`, err);
        }

        return reply.send({
            message: `Successfully created invite for qbt user ${invite.user_id} - ${result._status_code} ${result._status_message}`,
        });
    } catch (err) {
        elog(`[invite] QBT invitation failed for hres ${hres_id}:`, err);
        return reply.code(502).send({ message: String(err) });
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
