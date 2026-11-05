import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { QueryCommand, ScanCommand, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import { readAll } from "./backup-common.js";
import { runRestore, writeItems } from "./restore-backup.js";

const NOW = Date.UTC(2026, 10, 5);
const quiet = () => {};

const userItem = sub => ({ PK: { S: `u#${sub}` }, SK: { S: `u#${sub}` }, "GSI1-PK": { S: "u#" }, "GSI1-SK": { S: `u#${sub}` } });
const task = (sub, id, extra = {}) => ({ PK: { S: `u#${sub}` }, SK: { S: `t#${id}` }, "GSI1-PK": { S: "b#1" }, "GSI1-SK": { S: "nil" }, Description: { S: id }, ...extra });

const backupOf = (items, fields = {}) => ({
    exportedAt: "2026-11-01T00:00:00.000Z",
    region: "eu-west-2",
    table: "ListPal-Dev",
    ...fields,
    itemCount: items.length,
    itemsSha256: createHash("sha256").update(JSON.stringify(items)).digest("hex"),
    items
});

// Pages two items at a time, so every read has to follow LastEvaluatedKey
function fakeClient(liveItems, { unprocessedOnce = false } = {}) {
    const reads = [];
    const writes = [];
    return {
        reads,
        writes,
        async send(command) {
            if (command instanceof BatchWriteItemCommand) {
                const [requests] = Object.values(command.input.RequestItems);
                writes.push(requests.map(request => request.PutRequest.Item));
                if (unprocessedOnce) {
                    unprocessedOnce = false;
                    return { UnprocessedItems: command.input.RequestItems };
                }
                return {};
            }
            reads.push(command);
            const pk = command.input.ExpressionAttributeValues?.[":pk"].S;
            const matching = liveItems.filter(item => !pk || item.PK.S === pk);
            const start = Number(command.input.ExclusiveStartKey?.i.N ?? 0);
            const end = start + 2;
            return {
                Items: matching.slice(start, end),
                LastEvaluatedKey: end < matching.length ? { i: { N: String(end) } } : undefined
            };
        }
    };
}

const written = client => client.writes.flat().map(item => `${item.PK.S} ${item.SK.S}`).sort();

test("readAll follows every page with consistent reads", async () => {
    const live = [1, 2, 3, 4, 5].map(n => task("a", n));
    const client = fakeClient(live);
    const items = await readAll(client, ScanCommand, { TableName: "ListPal-Dev" });
    assert.deepEqual(items, live);
    assert.equal(client.reads.length, 3);
    assert.ok(client.reads.every(command => command.input.ConsistentRead));
});

test("a full backup restores missing items in every partition, from one scan", async () => {
    const backup = backupOf([userItem("a"), task("a", "1"), userItem("b"), task("b", "2"), task("b", "3")]);
    const client = fakeClient([userItem("a"), task("b", "3")]);
    const { plan } = await runRestore({ client, backup, apply: true, nowMs: NOW, log: quiet });

    assert.ok(client.reads.every(command => command instanceof ScanCommand));
    assert.equal(plan.unchanged.length, 2);
    assert.deepEqual(written(client), ["u#a t#1", "u#b t#2", "u#b u#b"]);
});

test("--user picks one partition out of a full backup and reads only that partition", async () => {
    const backup = backupOf([userItem("a"), task("a", "1"), userItem("b"), task("b", "2")]);
    const client = fakeClient([]);
    await runRestore({ client, backup, apply: true, user: "b", nowMs: NOW, log: quiet });

    assert.ok(client.reads.every(command => command instanceof QueryCommand && command.input.ExpressionAttributeValues[":pk"].S === "u#b"));
    assert.deepEqual(written(client), ["u#b t#2", "u#b u#b"]);
});

test("--user with --to-sub moves the user's keys into the new account", async () => {
    const backup = backupOf([userItem("a"), task("a", "1"), userItem("b")]);
    const client = fakeClient([]);
    await runRestore({ client, backup, apply: true, user: "a", toSub: "new", nowMs: NOW, log: quiet });

    assert.deepEqual(written(client), ["u#new t#1", "u#new u#new"]);
    assert.equal(client.writes.flat().find(item => item.SK.S === "u#new")["GSI1-SK"].S, "u#new");
});

test("--to-sub on a full backup needs --user, and stops before reading", async () => {
    const client = fakeClient([]);
    await assert.rejects(
        runRestore({ client, backup: backupOf([userItem("a")]), toSub: "new", log: quiet }),
        /add --user/
    );
    assert.equal(client.reads.length, 0);
});

test("--user must match a user backup, and must exist in a full backup", async () => {
    const userBackup = backupOf([userItem("a")], { userID: "u#a" });
    await assert.rejects(runRestore({ client: fakeClient([]), backup: userBackup, user: "b", log: quiet }), /holds u#a only/);
    await assert.rejects(runRestore({ client: fakeClient([]), backup: backupOf([userItem("a")]), user: "b", log: quiet }), /no items for u#b/);
});

test("a dry run writes nothing, and expired tasks are skipped", async () => {
    const expired = task("a", "old", { ExpiryDateTTL: { N: String(NOW / 1000 - 60) } });
    const backup = backupOf([userItem("a"), expired]);
    const client = fakeClient([]);
    const { plan, written: count } = await runRestore({ client, backup, nowMs: NOW, log: quiet });

    assert.equal(count, 0);
    assert.equal(client.writes.length, 0);
    assert.deepEqual(plan.expired, [expired]);
    assert.equal(plan.missing.length, 1);
});

test("changed items are kept unless --overwrite", async () => {
    const backup = backupOf([task("a", "1")], { userID: "u#a" });
    const edited = [task("a", "1", { Description: { S: "edited" } })];

    const keep = fakeClient(edited);
    await runRestore({ client: keep, backup, apply: true, nowMs: NOW, log: quiet });
    assert.equal(keep.writes.flat().length, 0);

    const replace = fakeClient(edited);
    await runRestore({ client: replace, backup, apply: true, overwrite: true, nowMs: NOW, log: quiet });
    assert.deepEqual(written(replace), ["u#a t#1"]);
});

test("a backup file that has changed is refused", async () => {
    const backup = backupOf([task("a", "1")]);
    backup.items[0].Description.S = "tampered";
    await assert.rejects(runRestore({ client: fakeClient([]), backup, log: quiet }), /checksum mismatch/);
});

test("writeItems resends unprocessed items", async () => {
    const client = fakeClient([], { unprocessedOnce: true });
    await writeItems(client, "ListPal-Dev", [task("a", "1")], { retryDelayMs: 0 });
    assert.equal(client.writes.length, 2);
});
