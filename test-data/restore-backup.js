// Restores items from a backup-user.js or backup-all.js file. Without --apply it only reports what would change.
// It never deletes anything: items that aren't in the backup are left alone.
//
// Usage: node restore-backup.js <backup file> [--apply] [--overwrite] [--user <sub>] [--to-sub <sub>]
//   --apply      Write to the table. Without it, nothing is written.
//   --overwrite  Also put back items that differ from the backup, losing edits made since it was taken.
//                Without it, only missing items are written.
//   --user       Restore only this user's items from a backup-all.js file. Without it, every partition
//                in that file is restored.
//   --to-sub     Restore into a different user. Deleting a Cognito user loses its sub for good, so a
//                replacement account has a new one, and the items must move to its partition.
import { DynamoDBClient, QueryCommand, ScanCommand, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readAll } from "./backup-common.js";

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 8;

// Sorted keys, as DynamoDB doesn't return an item's attributes in a set order
const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const itemKey = item => `${item.PK.S}\u0000${item.SK.S}`;

export function verifyBackup(backup) {
    const hash = createHash("sha256").update(JSON.stringify(backup.items)).digest("hex");
    if (hash !== backup.itemsSha256) throw new Error("Backup file has changed since it was written: checksum mismatch");
    if (backup.items.length !== backup.itemCount) throw new Error("Backup file has the wrong number of items");
}

// Only the user item's SK and GSI1-SK hold the user's ID. Board and task IDs are opaque, and keep working as they are.
export function moveToUser(item, fromUserID, toUserID) {
    const moved = { ...item, PK: { S: toUserID } };
    if (item.SK.S === fromUserID) moved.SK = { S: toUserID };
    if (item["GSI1-SK"]?.S === fromUserID) moved["GSI1-SK"] = { S: toUserID };
    return moved;
}

export function planRestore(backupItems, liveItems, nowMs) {
    const live = new Map(liveItems.map(item => [itemKey(item), item]));
    const backupKeys = new Set(backupItems.map(itemKey));
    const plan = { missing: [], changed: [], unchanged: [], expired: [], notInBackup: [] };
    for (const item of backupItems) {
        const current = live.get(itemKey(item));
        if (current) {
            (same(item, current) ? plan.unchanged : plan.changed).push(item);
            continue;
        }
        // Ticked tasks are meant to go once they expire, and the table's TTL would delete a restored one again
        const ttl = Number(item.ExpiryDateTTL?.N ?? 0);
        (ttl > 0 && ttl * 1000 <= nowMs ? plan.expired : plan.missing).push(item);
    }
    plan.notInBackup = liveItems.filter(item => !backupKeys.has(itemKey(item)));
    return plan;
}

// A user backup holds one partition. A full backup holds them all, unless --user picks one out.
export function selectUser(backup, sub) {
    const userID = sub ? "u#" + sub : backup.userID;
    if (backup.userID && userID !== backup.userID) throw new Error(`This backup holds ${backup.userID} only`);
    if (!userID) return { userID, items: backup.items };
    const items = backup.items.filter(item => item.PK.S === userID);
    if (!backup.userID && !items.length) throw new Error(`The backup has no items for ${userID}`);
    return { userID, items };
}

export async function readLive(client, table, userID) {
    if (!userID) return readAll(client, ScanCommand, { TableName: table });
    return readAll(client, QueryCommand, {
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": { S: userID } }
    });
}

export async function writeItems(client, table, items, { retryDelayMs = 200 } = {}) {
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        let requests = items.slice(i, i + BATCH_SIZE).map(Item => ({ PutRequest: { Item } }));
        for (let attempt = 1; requests.length; attempt++) {
            if (attempt > MAX_ATTEMPTS) throw new Error(`${requests.length} items still unwritten after ${MAX_ATTEMPTS} attempts`);
            const result = await client.send(new BatchWriteItemCommand({ RequestItems: { [table]: requests } }));
            requests = result.UnprocessedItems?.[table] ?? [];
            if (requests.length) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        }
    }
}

export async function runRestore({ client, backup, apply = false, overwrite = false, user, toSub, nowMs = Date.now(), log = console.log }) {
    verifyBackup(backup);
    const { userID, items: selected } = selectUser(backup, user);
    if (toSub && !userID) throw new Error("--to-sub moves one user: add --user <sub> to pick them from this full backup");
    const toUserID = toSub ? "u#" + toSub : userID;
    const items = userID ? selected.map(item => moveToUser(item, userID, toUserID)) : selected;
    const live = await readLive(client, backup.table, toUserID);
    const plan = planRestore(items, live, nowMs);
    const toWrite = overwrite ? [...plan.missing, ...plan.changed] : plan.missing;

    const readFrom = backup.sourceTable && backup.sourceTable !== backup.table ? ` (read from ${backup.sourceTable})` : "";
    log(`Backup from ${backup.exportedAt}${readFrom}, restoring into ${toUserID ?? "every partition"} in ${backup.table}`);
    log(`  Already identical:              ${plan.unchanged.length}`);
    log(`  Missing, will be restored:      ${plan.missing.length}`);
    log(`  Changed since the backup:       ${plan.changed.length}${overwrite ? " (will be overwritten)" : " (kept, use --overwrite to replace)"}`);
    log(`  Missing but past expiry:        ${plan.expired.length} (skipped, as the TTL would delete them again)`);
    log(`  Not in the backup:              ${plan.notInBackup.length} (never touched)`);

    if (!apply) {
        log(`Nothing written. Add --apply to write ${toWrite.length} items.`);
        return { plan, written: 0 };
    }
    await writeItems(client, backup.table, toWrite);
    log(`Wrote ${toWrite.length} items.`);
    return { plan, written: toWrite.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { values, positionals: [file] } = parseArgs({
        allowPositionals: true,
        options: {
            apply: { type: "boolean" },
            overwrite: { type: "boolean" },
            user: { type: "string" },
            "to-sub": { type: "string" }
        }
    });
    if (!file) {
        console.error("Usage: node restore-backup.js <backup file> [--apply] [--overwrite] [--user <sub>] [--to-sub <sub>]");
        process.exit(1);
    }
    const backup = JSON.parse(fs.readFileSync(file, "utf8"));
    await runRestore({
        client: new DynamoDBClient({ region: backup.region }),
        backup,
        apply: values.apply,
        overwrite: values.overwrite,
        user: values.user,
        toSub: values["to-sub"]
    });
}
