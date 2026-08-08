/**
 * The Mongo handle, shared by every function in this deployment.
 *
 * Serverless makes connection pooling a hazard: each invocation that opens its
 * own client eventually exhausts the cluster's connection limit, and Atlas M0
 * allows 500. So the client lives on `globalThis`, where it survives between
 * invocations that land on the same warm instance, and the *promise* is cached
 * rather than the resolved client so two concurrent cold requests share one
 * connect instead of racing to open two.
 *
 * Indexes are ensured once per process on the same promise. `createIndex` is
 * idempotent, so this costs one round trip per cold start and buys never having
 * to remember to run a migration by hand.
 */
import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb';

/** A registered account. One document, and the password never appears in it. */
export interface UserDoc {
  _id: ObjectId;
  /** lower-cased, which is also what the unique index is built on */
  email: string;
  /** `scrypt$<salt>$<key>`, see session.ts */
  password: string;
  createdAt: Date;
}

/** One saved thing, in the shape the browser already keeps it in. */
export interface LibraryEntry {
  id: string;
  name: string;
  /** the share code — never the decoded state, see the note in links.ts */
  code: string;
  points?: number;
  slots?: number;
  treeVersion?: number;
  savedAt: number;
}

/**
 * Everything one account has saved, in a single document.
 *
 * A document per build would cost ~200 bytes of Mongo overhead each to store
 * ~60 bytes of payload, and every sync would be a multi-document read. A whole
 * library is a few kilobytes against the 16 MB document limit, so it travels as
 * one document and one round trip.
 */
export interface LibraryDoc {
  /** the owner's user id, so the library needs no index of its own */
  _id: ObjectId;
  atlas: LibraryEntry[];
  strategy: LibraryEntry[];
  /**
   * Deletions, as `id` -> when. Without these a delete on one device is undone
   * by the next sync from another that still has the entry. Trimmed to the most
   * recent few hundred, long past the point where a stale device could resurrect
   * anything.
   */
  gone: Record<string, number>;
  updatedAt: Date;
}

/**
 * A short link. Field names are one letter because Mongo stores them in every
 * document, and at this document size the names would otherwise be a third of it.
 *
 *   _id  the slug, which doubles as the primary key so there is no second index
 *   k    kind: 'a' atlas, 's' strategy
 *   c    the share code
 *   u    the owner, or absent when it was made by an anonymous visitor
 *   h    sha256 of the code, unique, so sharing the same plan twice reuses one slug
 *   t    created
 *   x    when to drop it, absent for links that belong to an account
 */
export interface LinkDoc {
  _id: string;
  k: 'a' | 's';
  c: string;
  u?: ObjectId;
  h: string;
  t: Date;
  x?: Date;
}

/**
 * One counter per caller per action per window, dropped by TTL once the window
 * closes. Rate limiting has to live somewhere shared: an in-memory counter is
 * meaningless when every request may land on a different instance.
 */
export interface ThrottleDoc {
  /** `<action>:<ip>:<window>` */
  _id: string;
  n: number;
  x: Date;
}

interface Handle {
  db: Db;
  users: Collection<UserDoc>;
  libraries: Collection<LibraryDoc>;
  links: Collection<LinkDoc>;
  throttle: Collection<ThrottleDoc>;
}

declare global {
  // eslint-disable-next-line no-var
  var __poeMongo: Promise<Handle> | undefined;
}

async function connect(): Promise<Handle> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is not set');

  const client = new MongoClient(uri, {
    // One instance handles one request at a time, so a large pool buys nothing
    // and a small one keeps us far away from the cluster's connection ceiling.
    maxPoolSize: 5,
    // Fail fast rather than sitting on a request until the platform times it out.
    serverSelectionTimeoutMS: 8000,
  });
  await client.connect();

  const db = client.db(process.env['MONGODB_DB'] || 'poe_utils');
  const handle: Handle = {
    db,
    users: db.collection<UserDoc>('users'),
    libraries: db.collection<LibraryDoc>('libraries'),
    links: db.collection<LinkDoc>('links'),
    throttle: db.collection<ThrottleDoc>('throttle'),
  };

  await Promise.all([
    handle.users.createIndex({ email: 1 }, { unique: true }),
    handle.throttle.createIndex({ x: 1 }, { expireAfterSeconds: 0 }),
    handle.links.createIndex({ h: 1 }, { unique: true }),
    // Mongo drops a document once `x` is in the past. Documents without `x` —
    // the ones an account owns — are left alone, which is exactly the rule we want.
    handle.links.createIndex({ x: 1 }, { expireAfterSeconds: 0 }),
    handle.links.createIndex({ u: 1, t: -1 }),
  ]);

  return handle;
}

export function mongo(): Promise<Handle> {
  // Cache the promise, not the client: two cold requests then share one connect.
  globalThis.__poeMongo ??= connect().catch((err) => {
    // A failed connect must not poison the cache, or the instance stays broken
    // for its whole life.
    globalThis.__poeMongo = undefined;
    throw err;
  });
  return globalThis.__poeMongo;
}
