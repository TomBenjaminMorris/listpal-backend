// One-off: removes the Email and Name copies from user items, now that Cognito is the only copy.
// Usage: node strip-user-fields.js, which only counts. Add --apply to write.
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: "eu-west-2" });
const TableName = "ListPal-Dev";
const apply = process.argv.includes("--apply");

let ExclusiveStartKey;
let count = 0;
do {
    const page = await client.send(new QueryCommand({
        TableName,
        IndexName: "GSI1",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "GSI1-PK" },
        ExpressionAttributeValues: { ":pk": { S: "u#" } },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey
    }));
    for (const { PK, SK } of page.Items ?? []) {
        count++;
        if (!apply) continue;
        await client.send(new UpdateItemCommand({
            TableName,
            Key: { PK, SK },
            UpdateExpression: "REMOVE Email, #name",
            ExpressionAttributeNames: { "#name": "Name" },
            ConditionExpression: "attribute_exists(SK)"
        }));
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(`${apply ? "Updated" : "Would update"} ${count} user items`);
