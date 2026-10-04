import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface FindMySubject { role: 'wearer' | 'responder'; address: string; name: string; incidentId?: string; responderId?: string }
export type FindMyRequestResult = { status: 'provider_accepted' | 'failed' | 'unknown'; detail: string; messageId?: string };
interface Request { id: string; key: string; subject: FindMySubject; chatId: string; status: 'queued' | 'attempting' | FindMyRequestResult['status']; detail: string; messageId?: string }

/** One native sharing card per explicit onboarding key, with no uncertain-send retries. */
export class FindMyRequests {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS find_my_requests (id TEXT PRIMARY KEY, issue_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL);`);
    for (const row of this.db.prepare('SELECT body FROM find_my_requests').all()) {
      const r = JSON.parse(String(row.body)) as Request;
      if (r.status === 'attempting') { r.status = 'unknown'; r.detail = 'Interrupted sharing request; no automatic retry.'; this.save(r); }
    }
  }
  private save(r: Request) { this.db.prepare('UPDATE find_my_requests SET body=? WHERE id=?').run(JSON.stringify(r), r.id); }
  queue(key: string, subject: FindMySubject, chatId: string): boolean {
    if (!key.trim() || key.length > 200 || !chatId.trim() || chatId.length > 500 || !/^\+[1-9]\d{7,14}$/.test(subject.address)
      || !subject.name.trim() || subject.name.length > 100 || !['wearer', 'responder'].includes(subject.role)
      || (subject.role === 'responder' && (!subject.incidentId || !subject.responderId))) return false;
    const r: Request = { id: randomUUID(), key, subject, chatId, status: 'queued', detail: 'Native sharing request queued.' };
    return this.db.prepare('INSERT OR IGNORE INTO find_my_requests VALUES(?,?,?)').run(r.id, key, JSON.stringify(r)).changes === 1;
  }
  claim(): Omit<Request, 'status' | 'detail' | 'key'> | null {
    for (const row of this.db.prepare('SELECT body FROM find_my_requests ORDER BY rowid').all()) {
      const r = JSON.parse(String(row.body)) as Request;
      if (r.status !== 'queued') continue;
      r.status = 'attempting'; r.detail = 'Submitting the native sharing request.'; this.save(r);
      return { id: r.id, subject: r.subject, chatId: r.chatId };
    }
    return null;
  }
  finish(id: string, result: FindMyRequestResult): void {
    const row = this.db.prepare('SELECT body FROM find_my_requests WHERE id=?').get(id); if (!row) return;
    const r = JSON.parse(String(row.body)) as Request; if (r.status !== 'attempting') return;
    r.status = result.status; r.detail = result.detail;
    if (typeof result.messageId === 'string' && result.messageId.trim() && result.messageId.length <= 500) r.messageId = result.messageId;
    this.save(r);
  }
  view(role: FindMySubject['role'] = 'wearer'): { status: Request['status']; detail: string } | null {
    const row = this.db.prepare("SELECT body FROM find_my_requests WHERE json_extract(body,'$.subject.role')=? ORDER BY rowid DESC LIMIT 1").get(role);
    if (!row) return null;
    const r = JSON.parse(String(row.body)) as Request; return { status: r.status, detail: r.detail };
  }
  close() { this.db.close(); }
}
