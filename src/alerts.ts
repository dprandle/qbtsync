import { hostname } from "os";
import { config } from "./config";
import { cursor_floor_state, cursor_progress, get_sync_state, save_floor_alert_state } from "./sync_state";

// Floored-cursor alerting. Every sync pass reports its final cursor_progress here;
// a pass whose earliest_unresolved is set was "floored" — the cursor is pinned below
// that item and the loop re-scans everything newer each pass. That's by design for
// transient blocks (a trec waiting one tick for its user mapping), but the same item
// staying the floor for many consecutive passes means the loop is wedged on
// something that won't fix itself (unmapped user/jobcode, repeating per-item error)
// and a human should look. Streaks are persisted in sync_state so restarts don't
// reset them; emails go through SendGrid and are throttled per blocking item.

const SENDGRID_SEND_EMAIL_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

function email_configured(): boolean {
    return Boolean(config.sendgrid_api_key && config.alert_email_to);
}

// .env.example documents the key as the full "Bearer SG.xxx" header value, but accept
// a bare key too.
function auth_header(): string {
    const key = config.sendgrid_api_key;
    return key.startsWith("Bearer ") ? key : `Bearer ${key}`;
}

// SendGrid v3 send: success is an empty 202; anything else carries a JSON error body
// worth surfacing in the log.
async function send_alert_email(subject: string, body: string): Promise<void> {
    const resp = await fetch(SENDGRID_SEND_EMAIL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: auth_header(), "Content-Type": "application/json" },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: config.alert_email_to }] }],
            from: { email: config.alert_email_from, name: "qbtsync" },
            subject,
            content: [{ type: "text/plain", value: body }],
        }),
    });
    if (resp.status !== 202) {
        throw new Error(`SendGrid send failed (${resp.status}): ${await resp.text()}`);
    }
}

function alert_body(name: string, cur: cursor_floor_state): string {
    return [
        `Cursor "${name}" on ${hostname()} (QBT_ENV=${config.qbt_env}) has been floored on the same item for ${cur.consecutive} consecutive passes.`,
        ``,
        `Floored since:  ${cur.floored_since.toISOString()}`,
        `Floor value:    ${cur.floor.toISOString()} (earliest unresolved item timestamp)`,
        `Blocking item:  ${cur.detail || "(unknown)"}`,
        ``,
        `Until this item resolves, every pass re-scans all items newer than the floor.`,
        `Inspect with: journalctl -u qbtsync | grep -E "Skipping without cursor advance|Error"`,
    ].join("\n");
}

// Called once per completed pass per cursor. Never throws — alerting must not be
// able to break the sync loop.
export async function track_cursor_floor(name: string, progress: cursor_progress): Promise<void> {
    try {
        const prev = get_sync_state().floor_alerts[name];
        const floor = progress.earliest_unresolved;
        if (!floor) {
            if (prev) {
                ilog(`[alert] Cursor "${name}" floor cleared after ${prev.consecutive} pass(es)`);
                save_floor_alert_state(name, null);
            }
            return;
        }

        // A different blocking item restarts the streak: the loop is making
        // item-to-item progress, just with a new blocker at the front.
        const same_item = prev && prev.floor.getTime() === floor.getTime();
        const cur: cursor_floor_state = same_item
            ? {
                  ...prev,
                  consecutive: prev.consecutive + 1,
                  detail: progress.earliest_unresolved_detail || prev.detail,
              }
            : {
                  floor,
                  detail: progress.earliest_unresolved_detail ?? "",
                  floored_since: new Date(),
                  consecutive: 1,
                  last_alerted: null,
              };
        save_floor_alert_state(name, cur);

        const realert_ms = config.cursor_floor_realert_hours * 3_600_000;
        const due =
            cur.consecutive >= config.cursor_floor_alert_passes &&
            (!cur.last_alerted || Date.now() - cur.last_alerted.getTime() >= realert_ms);
        if (!due) return;

        if (!email_configured()) {
            // Log once per streak at the threshold crossing; without last_alerted
            // set, a later config change + restart still alerts on the next pass.
            if (cur.consecutive === config.cursor_floor_alert_passes) {
                wlog(
                    `[alert] Cursor "${name}" floored for ${cur.consecutive} passes on ${cur.detail || cur.floor.toISOString()} — email alerts not configured (SENDGRID_API_KEY / ALERT_EMAIL_TO)`
                );
            }
            return;
        }

        const subject = `[qbtsync ${config.qbt_env}] ${name} cursor floored for ${cur.consecutive} passes`;
        await send_alert_email(subject, alert_body(name, cur));
        cur.last_alerted = new Date();
        save_floor_alert_state(name, cur);
        wlog(`[alert] Sent floored-cursor email for "${name}" (blocking: ${cur.detail || cur.floor.toISOString()})`);
    } catch (err) {
        elog(`[alert] Floored-cursor alert for "${name}" failed:`, err);
    }
}
