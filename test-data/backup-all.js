// Saves the whole table and every Cognito user to a local file: the monthly copy kept off AWS. Only reads from AWS.
// Usage: node backup-all.js [output directory] [--table <name>]
//   --table  Read from another table, such as a point-in-time restore of ListPal-Dev. The file still
//            restores into ListPal-Dev.
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { parseArgs } from "node:util";
import { REGION, TABLE, DEFAULT_DIR, listCognitoUsers, cognitoProfile, readAll, restorePoint, writeBackup } from "./backup-common.js";

const { values: { table }, positionals: [outputDir = DEFAULT_DIR] } = parseArgs({
    allowPositionals: true,
    options: { table: { type: "string", default: TABLE } }
});

// Cognito can't export passwords. The list keeps each email's sub, which a restore into a new account needs.
const cognitoUsers = listCognitoUsers().map(cognitoProfile);
const client = new DynamoDBClient({ region: REGION });
const items = await readAll(client, ScanCommand, { TableName: table });

const fields = { sourceTable: table, restorePoint: await restorePoint(client, table), cognitoUsers };
const result = writeBackup(outputDir, "listpal-full-backup", fields, items);
console.log(JSON.stringify({ ...result, cognitoUsers: cognitoUsers.length }, null, 2));
