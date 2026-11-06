"use strict";
const { GetItemCommand } = require("@aws-sdk/client-dynamodb");

// One opt-out covers every AI feature. Only a user who turned it off has the field, so everyone else keeps AI on.
const aiEnabled = user => user?.AIEnabled?.BOOL !== false;

// Every route that sends a user's text to an AI service checks this first. The client hides AI features once the
// user opts out, but another device or an open tab can still hold the old setting.
async function userAllowsAI(client, tableName, userID) {
  const result = await client.send(new GetItemCommand({
    TableName: tableName,
    Key: { PK: { S: userID }, SK: { S: userID } },
    ProjectionExpression: "AIEnabled",
    // An opt-out has to hold from the moment it is saved
    ConsistentRead: true
  }));
  return aiEnabled(result.Item);
}

module.exports = { userAllowsAI };
