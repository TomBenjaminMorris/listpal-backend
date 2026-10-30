"use strict";
const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient();
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const tableName = "ListPal-" + process.env.Env;

module.exports.handler = async (event) => {
  try {
    let frequency = '';
    if (event.resources[0]) {
      if (event.resources[0].includes("weekly")) {
        frequency = "WScore";
      } else if (event.resources[0].includes("monthly")) {
        frequency = "MScore";
      } else if (event.resources[0].includes("yearly")) {
        frequency = "YScore";
      }
    }

    const allBoards = await query(allBoardsQuery());
    const data = allBoards && allBoards.Items.map((item) => {
      return unmarshall(item);
    });

    let result = []
    try {
      for (const board of data) {
        const writeResult = await update(updateBoardScores(board.PK, board.SK, frequency));
        result.push(writeResult)
      }
      return result
    } catch (e) {
      // EventBridge ignores the return value, so without this a failed reset leaves no trace
      console.error("Score reset failed:", e);
      return "Batch update failed: " + e;
    }

  } catch (error) {
    console.log(error);
  }
}

async function query(input) {
  const command = new QueryCommand(input);
  const result = await client.send(command);
  return result
}

async function update(input) {
  const command = new UpdateItemCommand(input);
  const result = await client.send(command);
  return result
}

function allBoardsQuery() {
  return {
    "TableName": tableName,
    "IndexName": "GSI1",
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    "ProjectionExpression": "PK, SK",
    "ExpressionAttributeValues": {
      ":cd420": { "S": "b#" },
      ":cd421": { "S": "b#" }
    },
    "ExpressionAttributeNames": {
      "#cd420": "GSI1-PK",
      "#cd421": "GSI1-SK"
    }
  }
}

function updateBoardScores(userID, boardID, frequency) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb52": { "N": "0" }
    },
    "ExpressionAttributeNames": {
      "#9eb52": frequency
    }
  }
}
