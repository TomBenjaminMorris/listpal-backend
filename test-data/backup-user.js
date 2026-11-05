// Saves one user's table items and Cognito profile to a local file. Only reads from AWS.
// Usage: node backup-user.js (<email> | --sub <sub>) [output directory] [--table <name>]
//   --sub    Find the user by Cognito sub instead, such as one whose account has been deleted.
//            Its sub is in a backup-all.js file.
//   --table  Read from another table, such as a point-in-time restore of ListPal-Dev. The file still
//            restores into ListPal-Dev.
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { parseArgs } from "node:util";
import { REGION, TABLE, DEFAULT_DIR, listCognitoUsers, cognitoProfile, readAll, restorePoint, writeBackup } from "./backup-common.js";

const { values: { sub, table }, positionals } = parseArgs({
    allowPositionals: true,
    options: { sub: { type: "string" }, table: { type: "string", default: TABLE } }
});
const [email, outputDir = DEFAULT_DIR] = sub ? [undefined, ...positionals] : positionals;
if (!email && !sub) {
    console.error("Usage: node backup-user.js (<email> | --sub <sub>) [output directory] [--table <name>]");
    process.exit(1);
}

// The quotes and backslashes would break out of Cognito's filter syntax
if (/["\\]/.test(sub ?? email)) throw new Error("That value contains characters a Cognito filter can't hold");
const users = listCognitoUsers(sub ? `sub = "${sub}"` : `email = "${email}"`);
// A deleted account has no Cognito user, but its items can still be read from a point-in-time restore
if (users.length > 1 || (!users.length && !sub)) throw new Error(`Expected one Cognito user, found ${users.length}`);
if (!users.length) console.warn("No Cognito user has that sub, so the backup has no profile");

const cognito = users.length ? cognitoProfile(users[0]) : null;
const userID = "u#" + (sub ?? cognito.attributes.sub);

const client = new DynamoDBClient({ region: REGION });
const items = await readAll(client, QueryCommand, {
    TableName: table,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": { S: userID } }
});

const fields = { sourceTable: table, restorePoint: await restorePoint(client, table), userID, cognito };
const { file, itemCount, entityCounts } = writeBackup(outputDir, "listpal-user-backup", fields, items);
console.log(JSON.stringify({ file, userID, itemCount, entityCounts }, null, 2));
