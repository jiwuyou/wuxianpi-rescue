import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuthorType, CommentRecord } from "./contracts.js";

interface CommentInput {
  pluginId: string;
  version: string;
  parentId?: string | null;
  authorType: AuthorType;
  authorName: string;
  clientId: string;
  content: string;
  rating?: number | null;
  environment?: Record<string, unknown> | null;
}

type SqlRow = Record<string, string | number | bigint | null>;

function mapComment(row: SqlRow): CommentRecord {
  return {
    id: String(row.id),
    pluginId: String(row.plugin_id),
    version: String(row.version),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    authorType: String(row.author_type) as AuthorType,
    authorName: String(row.author_name),
    clientId: String(row.client_id),
    content: String(row.content),
    rating: row.rating === null ? null : Number(row.rating),
    environment: row.environment_json === null ? null : JSON.parse(String(row.environment_json)) as Record<string, unknown>,
    createdAt: String(row.created_at)
  };
}

export class CommentStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'maintainer')),
        author_name TEXT NOT NULL,
        client_id TEXT NOT NULL,
        content TEXT NOT NULL,
        rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
        environment_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comments_plugin_version_created
      ON comments(plugin_id, version, created_at);
    `);
  }

  create(input: CommentInput): CommentRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO comments (
        id, plugin_id, version, parent_id, author_type, author_name,
        client_id, content, rating, environment_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.pluginId,
      input.version,
      input.parentId ?? null,
      input.authorType,
      input.authorName,
      input.clientId,
      input.content,
      input.rating ?? null,
      input.environment ? JSON.stringify(input.environment) : null,
      createdAt
    );
    return this.get(id)!;
  }

  get(id: string): CommentRecord | null {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? mapComment(row) : null;
  }

  list(pluginId: string, version?: string): CommentRecord[] {
    const rows = version
      ? this.database.prepare("SELECT * FROM comments WHERE plugin_id = ? AND version = ? ORDER BY created_at ASC").all(pluginId, version)
      : this.database.prepare("SELECT * FROM comments WHERE plugin_id = ? ORDER BY created_at ASC").all(pluginId);
    return (rows as SqlRow[]).map(mapComment);
  }

  close(): void {
    this.database.close();
  }
}
