// Shared by backup-user.js, backup-all.js and restore-backup.js. Nothing here writes to AWS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const REGION = "eu-west-2";
export const TABLE = "ListPal-Dev";
export const USER_POOL = "eu-west-2_CwBCZpR9j";
export const DEFAULT_DIR = new URL("../../backups/", import.meta.url).pathname;

// The CLI follows Cognito's pagination itself, so this returns every match
export function listCognitoUsers(filter) {
    const args = ["cognito-idp", "list-users", "--region", REGION, "--user-pool-id", USER_POOL, "--output", "json"];
    if (filter) args.push("--filter", filter);
    return JSON.parse(execFileSync("aws", args, { encoding: "utf8" })).Users;
}

export function cognitoProfile(user) {
    return {
        username: user.Username,
        status: user.UserStatus,
        enabled: user.Enabled,
        createdAt: user.UserCreateDate,
        attributes: Object.fromEntries(user.Attributes.map(({ Name, Value }) => [Name, Value]))
    };
}

// Command is QueryCommand or ScanCommand. Reads are consistent, so a task synced moments ago isn't missed.
export async function readAll(client, Command, input) {
    const items = [];
    let ExclusiveStartKey;
    do {
        const page = await client.send(new Command({ ...input, ConsistentRead: true, ExclusiveStartKey }));
        items.push(...page.Items);
        ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

// Items stay in DynamoDB's typed format, so a restore writes back exactly what was read.
// `table` is where a restore writes, and `sourceTable` where the items were read, such as a point-in-time restore.
export function writeBackup(outputDir, prefix, fields, items) {
    const entityCounts = {};
    for (const item of items) {
        const type = item.EntityType?.S ?? "(no EntityType)";
        entityCounts[type] = (entityCounts[type] ?? 0) + 1;
    }

    const exportedAt = new Date().toISOString();
    const backup = {
        exportedAt,
        region: REGION,
        table: TABLE,
        userPool: USER_POOL,
        ...fields,
        itemCount: items.length,
        entityCounts,
        itemsSha256: createHash("sha256").update(JSON.stringify(items)).digest("hex"),
        items
    };

    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const file = path.join(outputDir, `${prefix}-${exportedAt.replace(/[:.]/g, "-")}.json`);
    // Holds real email addresses and personal tasks, so only this macOS user can read it
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), { mode: 0o600 });
    return { file, itemCount: items.length, entityCounts };
}
