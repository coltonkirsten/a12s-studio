import type { DatabaseSync } from "node:sqlite";
import { audit, type GrantRow, tx } from "./db.ts";

// Expiry is enforced when a call is matched; this only records, once, that a grant ran out.
export function sweep(db: DatabaseSync, now: number): void {
  tx(db, () => {
    const due = db
      .prepare("SELECT * FROM grants WHERE expires_at <= ? AND expired_at IS NULL AND revoked_at IS NULL")
      .all(now) as GrantRow[];
    for (const grant of due) {
      db.prepare("UPDATE grants SET expired_at = ? WHERE id = ?").run(now, grant.id);
      audit(db, now, {
        teamId: grant.team_id,
        actor: "broker",
        action: "grant.expire",
        host: grant.host,
        grantId: grant.id,
      });
    }
  });
}
