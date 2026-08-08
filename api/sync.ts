/**
 * The saved libraries, kept in step across a signed-in visitor's devices.
 *
 *   GET  /api/sync — the account's copy
 *   POST /api/sync — send this device's copy, get the merge back
 *
 * There is one call, not one per save: the client posts what it has and adopts
 * the answer, so the merge only ever happens in one place (see merge.ts). What
 * travels is the same `{ name, code }` the browser already stores — the code is
 * the strategy, so there is nothing else to send.
 */
import { ObjectId } from 'mongodb';
import { mongo, type LibraryDoc } from './_lib/db';
import { fail, handler, json, readBody } from './_lib/http';
import { mergeEntries, mergeTombstones, readEntries, readTombstones } from './_lib/merge';
import { readSession } from './_lib/session';

const empty = (id: ObjectId): LibraryDoc => ({
  _id: id,
  atlas: [],
  strategy: [],
  gone: {},
  updatedAt: new Date(0),
});

export const GET = handler(async (request) => {
  const session = readSession(request);
  if (!session) return fail(401, 'Sign in first.');

  const { libraries } = await mongo();
  const doc = (await libraries.findOne({ _id: new ObjectId(session.uid) })) ?? empty(new ObjectId(session.uid));
  return json({ atlas: doc.atlas, strategy: doc.strategy, gone: doc.gone });
});

export const POST = handler(async (request) => {
  const session = readSession(request);
  if (!session) return fail(401, 'Sign in first.');

  const body = await readBody(request);
  const incoming = {
    atlas: readEntries(body['atlas'], 'Builds'),
    strategy: readEntries(body['strategy'], 'Strategies'),
    gone: readTombstones(body['gone']),
  };

  const id = new ObjectId(session.uid);
  const { libraries } = await mongo();
  const stored = (await libraries.findOne({ _id: id })) ?? empty(id);

  const gone = mergeTombstones(stored.gone ?? {}, incoming.gone);
  const merged: LibraryDoc = {
    _id: id,
    atlas: mergeEntries(stored.atlas ?? [], incoming.atlas, gone),
    strategy: mergeEntries(stored.strategy ?? [], incoming.strategy, gone),
    gone,
    updatedAt: new Date(),
  };

  await libraries.replaceOne({ _id: id }, merged, { upsert: true });
  return json({ atlas: merged.atlas, strategy: merged.strategy, gone: merged.gone });
});
