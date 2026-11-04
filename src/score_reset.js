"use strict";
const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env;

// Matched against the cron rule names in terraform/cronjob.tf
const RULE_FIELDS = { weekly: "WScore", monthly: "MScore", yearly: "YScore" };

module.exports.handler = async (event) => {
  const rule = event.resources?.[0] ?? "";
  const field = Object.entries(RULE_FIELDS).find(([name]) => rule.includes(name))?.[1];
  // EventBridge ignores the return value, so without these logs a failed reset leaves no trace
  if (!field) {
    console.error("Score reset failed: no score field for rule", rule);
    return;
  }

  try {
    const { Items = [] } = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "#pk = :board And begins_with(#sk, :board)",
      ProjectionExpression: "PK, SK",
      ExpressionAttributeNames: { "#pk": "GSI1-PK", "#sk": "GSI1-SK" },
      ExpressionAttributeValues: marshall({ ":board": "b#" })
    }));

    const result = [];
    for (const { PK, SK } of Items) {
      result.push(await client.send(new UpdateItemCommand({
        TableName: tableName,
        Key: { PK, SK },
        UpdateExpression: "SET #score = :zero",
        ExpressionAttributeNames: { "#score": field },
        ExpressionAttributeValues: marshall({ ":zero": 0 })
      })));
    }
    return result;
  } catch (error) {
    console.error("Score reset failed:", error);
    return "Batch update failed: " + error;
  }
};
